"""
scripts/market_stats_backfill.py — US-wide asking-price stats for the make/model/year of cars we can't rate.
Run by hand: PYTHONPATH=. python3 scripts/market_stats_backfill.py [--limit 10] [--dry-run]
`fetch_market_stats(session, limit)` is the part a nightly runner could call.

One MarketCheck call per make/model/year (nationwide, no zip), most unrated active listings first,
skipping keys fetched in the last 30 days. Same call counter and 480 cap as specs_decode_backfill.
"""
import argparse
from datetime import datetime, timedelta

from sqlalchemy import func

from db.models import CarListing, MarketStats, Prediction, init_db, get_session
from scripts.specs_decode_backfill import mc_get


def todo(session) -> list[tuple]:
    """(make, model, year, unrated listings) not fetched in 30 days, most unrated first."""
    fresh = {(m.make, m.model, m.year) for m in session.query(MarketStats).filter(MarketStats.fetched_at > datetime.utcnow() - timedelta(days=30))}
    q = (session.query(CarListing.make, CarListing.model, CarListing.year, func.count())
         .join(Prediction, Prediction.listing_id == CarListing.listing_id)
         .filter(CarListing.is_active == 1, Prediction.deal_score.is_(None), CarListing.make.isnot(None),
                 CarListing.model.isnot(None), CarListing.year.isnot(None))
         .group_by(CarListing.make, CarListing.model, CarListing.year).order_by(func.count().desc()))
    return [r for r in q if r[:3] not in fresh]


def fetch_market_stats(session, limit: int = 10, dry_run: bool = False) -> int:
    """Fetch and store stats for up to `limit` keys; returns rows written. Stops after 3 failures in a row."""
    done = fails = 0
    for make, model, year, n in todo(session)[:limit]:
        if dry_run:
            print(f"would fetch {year} {make} {model} ({n} unrated)")
            continue
        if fails >= 3:
            print("3 failed calls in a row, stopping")
            break
        try:
            body = mc_get("search/car/active", {"make": make, "model": model, "year": year, "car_type": "used", "stats": "price", "rows": 0})
        except RuntimeError as e:
            fails += 1
            print(f"{year} {make} {model}: failed ({e})")
            continue
        fails = 0
        p = (body.get("stats") or {}).get("price") or {}
        pct = p.get("percentiles") or {}
        row = session.query(MarketStats).filter_by(make=make, model=model, year=year).first() or MarketStats(make=make, model=model, year=year)
        row.listing_count, row.price_median = body.get("num_found"), p.get("median")
        row.price_p25, row.price_p75, row.fetched_at = pct.get("25.0"), pct.get("75.0"), datetime.utcnow()
        session.add(row)
        session.commit()
        done += 1
        print(f"{year} {make} {model}: {row.listing_count} listed, median {row.price_median}, p25 {row.price_p25}, p75 {row.price_p75}", flush=True)
    return done


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10, help="make/model/years to fetch this run")
    ap.add_argument("--dry-run", action="store_true", help="list what would be fetched, call nothing")
    a = ap.parse_args()
    fetch_market_stats(get_session(init_db()), a.limit, a.dry_run)
