"""
db/repository.py  ─  CRUD operations for Car Intel database

Abstracts all DB interactions so other modules stay clean.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from sqlalchemy.exc import IntegrityError

import pandas as pd
from loguru import logger
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from db.models import CarListing, Prediction, PopularitySnapshot


# ── Listings ──────────────────────────────────────────────────────────────────

class ListingRepository:
    def __init__(self, session: Session):
        self.session = session

    def upsert_listings(self, listings: list[dict]) -> tuple[int, int]:
        """
        Insert new listings; update last_seen + days_listed for existing ones.
        listing_id is globally unique (DB constraint), so we upsert by listing_id only.
        Returns (inserted, updated).
        """
        inserted = updated = 0
        now = datetime.utcnow()

        for data in listings:
            listing_id = data.get("listing_id")
            if not listing_id:
                continue

            existing = (
                self.session.query(CarListing)
                .filter_by(listing_id=listing_id)
                .first()
            )

            if existing:
                # Confirm still active and stamp when we last saw it
                existing.last_seen = now
                existing.is_active = 1

                # Only mutable fields that can legitimately change between scrapes:
                # price (dealer reductions), mileage (odometer corrections),
                # days_listed from API dom (reflects actual market age),
                # and dealer metadata
                mutable_fields = {
                    "price", "mileage", "days_listed",
                    "dealer_name", "dealer_rating",
                    "location_city", "location_state", "location_zip",
                    "scrape_source",
                }
                for k in mutable_fields:
                    v = data.get(k)
                    if v is not None and hasattr(existing, k):
                        setattr(existing, k, v)

                updated += 1
            else:
                try:
                    listing = CarListing(**{k: v for k, v in data.items() if hasattr(CarListing, k)})
                    self.session.add(listing)
                    inserted += 1
                except Exception as e:
                    logger.warning(f"Failed to add listing {listing_id}: {e}")

        try:
            self.session.commit()
        except IntegrityError as e:
            # Safety net: if anything slipped through, rollback so session can continue
            self.session.rollback()
            logger.warning(f"IntegrityError during upsert_listings, rolled back: {e}")
            # Optional: you can re-run inserts one-by-one here, but usually the lookup fix prevents this.

        logger.info(f"Upsert complete: {inserted} inserted, {updated} updated")
        return inserted, updated

    def get_active_listings_df(self, min_price: float = 500) -> pd.DataFrame:
        """Return all active listings as a DataFrame — for display endpoints."""
        query = (
            self.session.query(CarListing)
            .filter(
                CarListing.is_active == True,  # noqa: E712
                CarListing.price > min_price,
                CarListing.year.isnot(None),
                CarListing.mileage.isnot(None),
            )
        )
        rows = [
            {c.name: getattr(r, c.name) for c in CarListing.__table__.columns}
            for r in query.all()
        ]
        return pd.DataFrame(rows)

    def get_training_listings_df(self) -> pd.DataFrame:
        """
        Rows the model trains on — every filter lives in training_listings_v
        (db/models.py). Ordered by id: train_test_split is order-sensitive.

        Like get_scoring_listings_df, this does not filter on is_active —
        a delisted car's price/mileage/features are still real training
        signal. Bounded by last_seen so the training set doesn't accumulate
        indefinitely-old rows that no longer reflect current pricing.
        """
        return pd.read_sql(
            text("SELECT * FROM training_listings_v ORDER BY id"),
            self.session.connection(),
            parse_dates=["first_seen", "last_seen"],
        )

    def get_cohort_stats(self, listing_ids) -> pd.DataFrame:
        """
        Median price and count per (make, model, year) over the given
        car_listings ids — the model's market-relative features. SQLite has
        no MEDIAN, so rank prices within each cohort and average the middle
        one (odd n) or two (even n), matching pandas' median.

        Keys are normalised like _build_features_raw (lower + trim).
        ponytail: SQLite LOWER/TRIM are ASCII-only while pandas' are Unicode;
        identical for today's data, revisit if non-ASCII makes/models appear.
        """
        sql = text("""
            WITH src AS (
                SELECT LOWER(TRIM(make)) AS make, LOWER(TRIM(model)) AS model, year, price
                FROM car_listings
                WHERE id IN (SELECT value FROM json_each(:ids))
            ), ranked AS (
                SELECT *,
                       ROW_NUMBER() OVER (PARTITION BY make, model, year ORDER BY price) AS rn,
                       COUNT(*)     OVER (PARTITION BY make, model, year)                AS n
                FROM src
            )
            SELECT make, model, year, AVG(price) AS cohort_median, MAX(n) AS cohort_count
            FROM ranked
            WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
            GROUP BY make, model, year
            ORDER BY make, model, year
        """)
        ids = json.dumps([int(i) for i in listing_ids])
        return pd.read_sql(sql, self.session.connection(), params={"ids": ids}).set_index(
            ["make", "model", "year"]
        )

    def get_scoring_listings_df(self, min_price: float = 500, max_days_since_seen: int = 180) -> pd.DataFrame:
        """
        Active *and* recently-delisted listings, for scoring.

        Deliberately looser than the training view: stale, very cheap/expensive
        and high-mileage listings still get a deal score even though the model
        doesn't learn "market" from them. Includes recently-delisted rows so
        predictions stay ready if a listing is re-seen and reactivated.
        """
        cutoff = datetime.utcnow() - timedelta(days=max_days_since_seen)
        query = (
            self.session.query(CarListing)
            .filter(
                CarListing.price > min_price,
                CarListing.year.isnot(None),
                CarListing.mileage.isnot(None),
                CarListing.last_seen >= cutoff,
            )
        )
        rows = [
            {c.name: getattr(r, c.name) for c in CarListing.__table__.columns}
            for r in query.all()
        ]
        return pd.DataFrame(rows)

    def mark_stale_inactive(self, stale_after_days: int = 180) -> int:
        """
        Mark listings we haven't re-confirmed in `stale_after_days` as
        inactive. Returns the number of rows flipped.

        Caveat: the scraper samples a rotating slice of zip codes and result
        pages each run (see scraper/data_ingest.py), not the full live
        inventory — a listing can legitimately go many runs without being
        re-seen while still being for sale. "Not seen recently" is a
        deliberately generous, approximate delisting signal, not a per-run
        one. Tune via the INACTIVE_AFTER_DAYS env var if it's marking too
        eagerly or too slowly for your scrape cadence/coverage.
        """
        cutoff = datetime.utcnow() - timedelta(days=stale_after_days)
        updated = (
            self.session.query(CarListing)
            .filter(CarListing.is_active == True, CarListing.last_seen < cutoff)  # noqa: E712
            .update({"is_active": 0}, synchronize_session=False)
        )
        self.session.commit()
        return int(updated)

    def get_all_listings_df(self, days_back: int = 90) -> pd.DataFrame:
        """Return all listings (including inactive) from the last N days."""
        cutoff = datetime.utcnow() - timedelta(days=days_back)
        query = self.session.query(CarListing).filter(CarListing.first_seen >= cutoff)

        rows = [
            {c.name: getattr(r, c.name) for c in CarListing.__table__.columns}
            for r in query.all()
        ]
        return pd.DataFrame(rows)

    def count_active(self) -> int:
        v = (
            self.session.query(func.count(CarListing.id))
            .filter_by(is_active=True)
            .scalar()
        )
        return int(v or 0)


# ── Predictions ───────────────────────────────────────────────────────────────

class PredictionRepository:
    def __init__(self, session: Session):
        self.session = session

    def save_predictions(self, predictions: list[dict]) -> None:
        """Upsert ML predictions for listings."""
        now = datetime.utcnow()

        for pred in predictions:
            listing_id = pred.get("listing_id")
            if not listing_id:
                continue

            existing = (
                self.session.query(Prediction)
                .filter_by(listing_id=listing_id)
                .first()
            )
            if existing:
                for k, v in pred.items():
                    setattr(existing, k, v)
                # If your Prediction model uses a different timestamp field, adjust here:
                if hasattr(existing, "predicted_at"):
                    existing.predicted_at = now
                elif hasattr(existing, "scored_at"):
                    existing.scored_at = now
            else:
                # Only set timestamp if the model has it
                if "predicted_at" not in pred and "scored_at" not in pred:
                    if hasattr(Prediction, "predicted_at"):
                        pred["predicted_at"] = now
                    elif hasattr(Prediction, "scored_at"):
                        pred["scored_at"] = now
                self.session.add(Prediction(**pred))

        self.session.commit()
        logger.info(f"Saved {len(predictions)} predictions")

    def get_top_deals(self, limit: int = 100, min_deal_score: float = 0.0) -> pd.DataFrame:
        """
        Return best deals currently active.

        deal_score is 0–100 where 100 is best.
        Filter with >= min_deal_score and sort descending.
        """
        results = (
            self.session.query(CarListing, Prediction)
            .join(Prediction, CarListing.listing_id == Prediction.listing_id)
            .filter(
                CarListing.is_active == True,  # noqa: E712
                Prediction.deal_score.isnot(None),
                Prediction.deal_score >= min_deal_score,
            )
            .order_by(Prediction.deal_score.desc())
            .limit(limit)
            .all()
        )

        rows = []
        for listing, pred in results:
            row = {c.name: getattr(listing, c.name) for c in CarListing.__table__.columns}

            # Prediction table fields (these must match your db/models.py)
            row["predicted_price"] = getattr(pred, "predicted_price", None)
            row["deal_score"] = getattr(pred, "deal_score", None)
            row["deal_label"] = getattr(pred, "deal_label", None)

            rows.append(row)

        return pd.DataFrame(rows)


# ── Popularity ────────────────────────────────────────────────────────────────

class PopularityRepository:
    def __init__(self, session: Session):
        self.session = session

    def save_snapshot(self, snapshots: list[dict]) -> None:
        for snap in snapshots:
            self.session.add(PopularitySnapshot(**snap))
        self.session.commit()
        logger.info(f"Saved popularity snapshot: {len(snapshots)} cohorts")

    def get_trending(self, top_n: int = 10) -> pd.DataFrame:
        """Return the currently most popular make/model combinations."""
        latest = self.session.query(func.max(PopularitySnapshot.snapshot_date)).scalar()
        if not latest:
            return pd.DataFrame()

        results = (
            self.session.query(PopularitySnapshot)
            .filter(PopularitySnapshot.snapshot_date == latest)
            .order_by(PopularitySnapshot.popularity_rank)
            .limit(top_n)
            .all()
        )

        rows = [
            {c.name: getattr(r, c.name) for c in PopularitySnapshot.__table__.columns}
            for r in results
        ]
        return pd.DataFrame(rows)