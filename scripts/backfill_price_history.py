"""
scripts/backfill_price_history.py — seed vin_price_history from the listing rows already stored.
Run by hand, once, before the first nightly scrape that writes history:
    PYTHONPATH=. python3 scripts/backfill_price_history.py [--dry-run]
A dealer's price cut arrives as a new listing row for the same VIN, so each row is one price, dated by
its first_seen; consecutive rows with the same price and miles collapse to one point. Safe to re-run:
a point already stored for (vin, date, price) is skipped. No MarketCheck calls.
Not backfilled: ref_price points. ref_price_dt was never stored, so those need a re-sighting by the scrape.
"""
import argparse
from itertools import groupby

from db.models import CarListing, VinPriceHistory, init_db, get_session


def backfill(session, dry_run: bool = False) -> int:
    have = {(v, d, p) for v, d, p in session.query(VinPriceHistory.vin, VinPriceHistory.date, VinPriceHistory.price)}
    rows = (session.query(CarListing.vin, CarListing.first_seen, CarListing.price, CarListing.mileage, CarListing.dealer_name)
            .filter(CarListing.vin.isnot(None), CarListing.vin != "", CarListing.price > 0, CarListing.first_seen.isnot(None))
            .order_by(CarListing.vin, CarListing.first_seen, CarListing.id))
    new = []
    for vin, group in groupby(rows, key=lambda r: r.vin):
        last = None
        for r in group:
            if (r.price, r.mileage) != last and (vin, r.first_seen, r.price) not in have:
                new.append(VinPriceHistory(vin=vin, date=r.first_seen, price=r.price, miles=r.mileage, seller=r.dealer_name, source="scrape"))
            last = (r.price, r.mileage)
    if not dry_run:
        session.add_all(new)
        session.commit()
    return len(new)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    dry = ap.parse_args().dry_run
    print(f"{'would add' if dry else 'added'} {backfill(get_session(init_db()), dry)} points")
