"""
db/repository.py  ─  CRUD operations for Car Intel database

Abstracts all DB interactions so other modules stay clean.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from sqlalchemy.exc import IntegrityError

import pandas as pd
from loguru import logger
from sqlalchemy import func
from sqlalchemy.orm import Session

from db.models import CarListing, Prediction, PopularitySnapshot, SalesStatsCache


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

    def mark_inactive(self, scrape_source: str = "cars.com", older_than_hours: int = 48) -> int:
        """Mark listings not seen in the last N hours as inactive (likely sold)."""
        cutoff = datetime.utcnow() - timedelta(hours=older_than_hours)
        count = (
            self.session.query(CarListing)
            .filter(
                CarListing.scrape_source == scrape_source,
                CarListing.last_seen < cutoff,
                CarListing.is_active == True,  # noqa: E712
            )
            .update({"is_active": False})
        )
        self.session.commit()
        logger.info(f"Marked {count} listings inactive")
        return int(count or 0)

    def get_active_listings_df(self, min_price: float = 500) -> pd.DataFrame:
        """Return all active listings as a DataFrame for ML training / dashboard."""
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
            row["confidence_low"] = getattr(pred, "confidence_low", None)
            row["confidence_high"] = getattr(pred, "confidence_high", None)

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

    def get_latest_snapshot_date(self):
        return self.session.query(func.max(PopularitySnapshot.snapshot_date)).scalar()

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


# ── Sales Stats Cache ──────────────────────────────────────────────────────────

class SalesStatsCacheRepository:
    CACHE_TTL_DAYS = 30

    def __init__(self, session: Session):
        self.session = session

    def get(self, make: str, state: str) -> SalesStatsCache | None:
        """Return cached entry if it exists and is less than 30 days old."""
        cutoff = datetime.utcnow() - timedelta(days=self.CACHE_TTL_DAYS)
        return (
            self.session.query(SalesStatsCache)
            .filter(
                SalesStatsCache.make == make.lower(),
                SalesStatsCache.state == state.upper(),
                SalesStatsCache.fetched_at >= cutoff,
            )
            .first()
        )

    def upsert(self, make: str, state: str, data: dict) -> None:
        """Insert or update a cache entry."""
        make = make.lower()
        state = state.upper()
        existing = (
            self.session.query(SalesStatsCache)
            .filter_by(make=make, state=state)
            .first()
        )
        if existing:
            existing.median_price       = data.get("median_price")
            existing.trimmed_mean_price = data.get("trimmed_mean_price")
            existing.median_dom         = data.get("median_dom")
            existing.sample_count       = data.get("sample_count")
            existing.fetched_at         = datetime.utcnow()
        else:
            self.session.add(SalesStatsCache(
                make=make,
                state=state,
                median_price=data.get("median_price"),
                trimmed_mean_price=data.get("trimmed_mean_price"),
                median_dom=data.get("median_dom"),
                sample_count=data.get("sample_count"),
                fetched_at=datetime.utcnow(),
            ))
        self.session.commit()

    def get_all_as_dict(self) -> dict:
        """Return all non-expired entries as {(make, model): {...}} for fast DataFrame joins.
        Note: the 'state' column stores the model name for (make, model) level cache entries."""
        cutoff = datetime.utcnow() - timedelta(days=self.CACHE_TTL_DAYS)
        rows = (
            self.session.query(SalesStatsCache)
            .filter(SalesStatsCache.fetched_at >= cutoff)
            .all()
        )
        return {
            (r.make, r.state): {
                "market_median_price":       r.median_price,
                "market_trimmed_mean_price": r.trimmed_mean_price,
                "market_dom_median":         r.median_dom,
                "market_sample_count":       r.sample_count,
            }
            for r in rows
        }