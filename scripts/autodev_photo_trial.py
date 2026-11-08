"""
scripts/autodev_photo_trial.py — Does Auto.dev's Vehicle Photos API cover our photo-less listings?
Run: PYTHONPATH=. python3 scripts/autodev_photo_trial.py

Takes the 50 newest active listings first seen since 2026-10-31 with no photo_url and a 17-char VIN,
calls GET https://api.auto.dev/photos/{vin} once each (at most 1 request a second) and prints the hit
rate, image hosts and 3 example URLs. Every response is cached in data/autodev_trial.json, so a rerun
makes no new calls. Read-only: nothing is written to the DB. Needs AUTODEV_API_KEY in .env
(free key at auto.dev: 1,000 calls a month, 5 requests a second).
"""
import json
import os
import sqlite3
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

from db.models import DB_PATH

load_dotenv()
N, SINCE = 50, "2026-10-31"
CACHE = Path("data/autodev_trial.json")
cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}

db = sqlite3.connect(DB_PATH.replace("sqlite:///", ""), timeout=30)
vins = [r[0] for r in db.execute(
    """SELECT vin FROM car_listings
       WHERE is_active = 1 AND first_seen >= ? AND (photo_url IS NULL OR photo_url = '') AND length(vin) = 17
       ORDER BY first_seen DESC, id DESC LIMIT ?""", (SINCE, N))]
print(f"Picked {len(vins)} VINs (newest first), e.g. {vins[:3]}")

key = os.getenv("AUTODEV_API_KEY", "")
todo = [v for v in vins if v not in cache]
if todo and not key:
    raise SystemExit(f"AUTODEV_API_KEY is not set in .env, so {len(todo)} VINs are uncached: stopping before any call.")

for v in todo:
    time.sleep(1)  # free plan allows 5 req/s; we stay at 1
    r = requests.get(f"https://api.auto.dev/photos/{v}", headers={"Authorization": f"Bearer {key}"}, timeout=20)
    cache[v] = {"status": r.status_code, "body": r.json() if "json" in r.headers.get("content-type", "") else r.text[:300]}
    CACHE.write_text(json.dumps(cache))
    if r.status_code in (401, 402, 403, 429):  # bad key, plan or quota: stop spending calls
        print(f"HTTP {r.status_code} on {v}: stopping.")
        break

done = {v: cache[v] for v in vins if v in cache}
urls = {v: ((c["body"] or {}).get("data") or {}).get("retail") or [] if isinstance(c["body"], dict) else [] for v, c in done.items()}
hits = {v: u for v, u in urls.items() if u}
print(f"\nStatus codes: {dict(Counter(c['status'] for c in done.values()))}")
print(f"Hit rate: {len(hits)}/{len(done)} VINs have at least one photo ({len(hits) / max(len(done), 1):.0%})")
print("Image hosts:", dict(Counter(urlparse(u[0]).netloc for u in hits.values())))
for v, u in list(hits.items())[:3]:
    print(f"  {v}: {u[0]}  ({len(u)} photos)")
