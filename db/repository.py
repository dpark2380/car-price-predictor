"""
db/repository.py  ─  CRUD operations for Car Intel database

Abstracts all DB interactions so other modules stay clean.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from sqlalchemy.exc import IntegrityError

import pandas as pd
from loguru import logger
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from db.models import CarListing, Prediction, PopularitySnapshot, PriceHistory, MIN_PRICE


def _df(query) -> pd.DataFrame:
    return pd.DataFrame([{c.name: getattr(r, c.name) for c in CarListing.__table__.columns} for r in query])


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

                price = data.get("price")
                if price is not None and price != existing.price:
                    self.session.add(PriceHistory(listing_id=listing_id, price=price, seen_at=now))

                # Only mutable fields that can legitimately change between scrapes:
                # price (dealer reductions), mileage (odometer corrections),
                # days_listed from API dom (reflects actual market age),
                # and dealer metadata. Spec fields are fixed per car but listed so
                # rows from before they were mapped (2026-11-01) fill in when re-seen.
                mutable_fields = {
                    "price", "mileage", "days_listed",
                    "dealer_name", "dealer_type", "dealer_phone", "dealer_street",
                    "location_city", "location_state", "location_zip",
                    "scrape_source", "photo_url", "photo_urls",
                    "transmission", "drivetrain", "fuel_type", "powertrain_type", "engine_size",
                    "cylinders", "doors", "seats", "city_mpg", "highway_mpg", "carfax_1_owner",
                    "ref_price", "price_change_percent", "dom_active",
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
                    if data.get("price") is not None:
                        self.session.add(PriceHistory(listing_id=listing_id, price=data["price"], seen_at=now))
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
        return _df(query)

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

    def get_scoring_listings_df(self, min_price: float = MIN_PRICE, max_days_since_seen: int = 180) -> pd.DataFrame:
        """
        Active *and* recently-delisted listings, for scoring.

        Deliberately looser than the training view: stale and high-mileage
        listings still get a deal score even though the model doesn't learn
        "market" from them. The price floor matches training (MIN_PRICE):
        below it the model has seen no cars. Includes recently-delisted rows so
        predictions stay ready if a listing is re-seen and reactivated.
        """
        cutoff = datetime.utcnow() - timedelta(days=max_days_since_seen)
        query = (
            self.session.query(CarListing)
            .filter(
                CarListing.price >= min_price,
                CarListing.year.isnot(None),
                CarListing.mileage.isnot(None),
                CarListing.last_seen >= cutoff,
            )
        )
        return _df(query)

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
                existing.scored_at = now
            else:
                pred.setdefault("scored_at", now)
                self.session.add(Prediction(**pred))

        self.session.commit()
        logger.info(f"Saved {len(predictions)} predictions")

    def _graded(self, *entities, unrated=False):
        """Active listings with a deal score (unrated=True: with or without),
        at or above the price floor.
        The floor is applied here too because predictions are upserted and
        never deleted, so rows scored before the floor existed linger."""
        return (
            self.session.query(*entities)
            .join(Prediction, CarListing.listing_id == Prediction.listing_id)
            .filter(
                CarListing.is_active == True,  # noqa: E712
                CarListing.price >= MIN_PRICE,
                *([] if unrated else [Prediction.deal_score.isnot(None)]),
            )
        )

    def count_graded(self) -> int:
        return int(self._graded(func.count(CarListing.id)).scalar() or 0)

    def get_top_deals(self, limit: int | None = 100, min_deal_score: float = 0.0,
                      include_unrated: bool = False) -> pd.DataFrame:
        """
        Return best deals currently active; limit=None returns all of them.

        deal_score is 0–100 where 100 is best.
        Filter with >= min_deal_score and sort descending. include_unrated
        adds the "Not rated" cars (NULL score), last.
        """
        query = self._graded(CarListing, Prediction, unrated=include_unrated)
        if not include_unrated:
            query = query.filter(Prediction.deal_score >= min_deal_score)
        query = query.order_by(Prediction.deal_score.desc())
        results = (query.limit(limit) if limit else query).all()

        rows = []
        for listing, pred in results:
            row = {c.name: getattr(listing, c.name) for c in CarListing.__table__.columns}
            row["predicted_price"] = pred.predicted_price
            row["deal_score"] = pred.deal_score
            row["deal_label"] = pred.deal_label
            row["comparables"] = pred.comparables
            row["typical_error_pct"] = pred.typical_error_pct
            row["cohort_median_price"] = pred.cohort_median_price

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