"""
scraper/vehicle_photos.py — Auto.dev photos for active listings MarketCheck sent without one.

A 50-VIN trial found photos for 58% of recent photo-less listings
(research/listing_photos_research.md). GET /photos/{vin} returns
{"data": {"retail": [urls]}}, or 404 when it has none. The image URLs on
api.auto.dev load without a key, so the site links to them directly.

The upsert only overwrites photo_url with a non-null value, so a MarketCheck
photo replaces ours when the dealer adds one, and a re-sighting never blanks it.
Free plan: 1,000 calls a month. These calls are NOT recorded in api_usage:
month_total() sums every provider and would eat the MarketCheck budget.
"""

import os
import time
from datetime import datetime, timedelta

import requests
from dotenv import load_dotenv
from loguru import logger

from db.models import CarListing, VinPhoto

load_dotenv()
API = "https://api.auto.dev/photos"
RETRY_MISS_DAYS = 14  # a fresh listing's photos can reach Auto.dev a few days later


def fill_missing(session, max_calls: int) -> int:
    """Look up photos for photo-less active listings, newest first. Returns calls made.
    Stops at max_calls, on an auth/quota error, or after 5 failures in a row."""
    key = os.getenv("AUTODEV_API_KEY", "").strip()
    if not key:
        logger.info("AUTODEV_API_KEY not set: skipping photo lookups")
        return 0

    retry_before = datetime.utcnow() - timedelta(days=RETRY_MISS_DAYS)
    done = {v for (v,) in session.query(VinPhoto.vin)
            .filter((VinPhoto.found == 1) | (VinPhoto.fetched_at >= retry_before))}
    todo = list(dict.fromkeys(  # dedupe, keeping newest-first order
        vin for (vin,) in (session.query(CarListing.vin)
                           .filter(CarListing.is_active == 1,
                                   (CarListing.photo_url.is_(None)) | (CarListing.photo_url == ""))
                           .order_by(CarListing.first_seen.desc()))
        if vin and len(vin) == 17 and vin not in done))

    calls = failures = found = 0
    for vin in todo[:max_calls]:
        if failures >= 5:
            break
        calls += 1
        time.sleep(1)  # free plan allows 5 a second
        try:
            r = requests.get(f"{API}/{vin}", headers={"Authorization": f"Bearer {key}"}, timeout=20)
        except requests.RequestException as e:
            failures += 1
            logger.warning(f"Auto.dev photo lookup failed: {e}")
            continue
        if r.status_code in (401, 402, 403, 429):  # bad key, plan or quota: stop spending calls
            logger.warning(f"Auto.dev returned HTTP {r.status_code}: stopping photo lookups")
            break
        if r.status_code not in (200, 404):
            failures += 1
            continue
        failures = 0
        urls = ((r.json().get("data") or {}).get("retail") or []) if r.status_code == 200 else []
        url = next((u for u in urls if isinstance(u, str) and u.startswith("https://")), None)
        if url:
            found += 1
            (session.query(CarListing)
             .filter(CarListing.vin == vin, (CarListing.photo_url.is_(None)) | (CarListing.photo_url == ""))
             .update({"photo_url": url}, synchronize_session=False))
        session.merge(VinPhoto(vin=vin, found=int(bool(url)), fetched_at=datetime.utcnow()))
        session.commit()

    logger.info(f"Auto.dev photos: {found} found in {calls} calls ({len(todo)} VINs without a photo)")
    return calls
