"""
scripts/specs_coverage.py — Probe CarSpecsAPI and RevCarData US coverage on their free keys.
Run: PYTHONPATH=. python3 scripts/specs_coverage.py

Takes our top year/make/models by active listing count and checks whether each
source has them. Every response is cached in data/specs_probe.json, so a rerun
makes no new calls. Free limits: CarSpecsAPI 100/day, RevCarData 100/month.
"""
import json
import os
import re
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

from db.models import init_db, get_session
from db.repository import ListingRepository

load_dotenv()
TOP_N = 30
CS_MAX, RCD_MAX = 60, 36  # call caps per run, under each free limit
CACHE = Path("data/specs_probe.json")
cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
calls = {"cs": 0, "rcd": 0}


def get(src, url, key, cap, **params):
    """GET with the response cached by URL; None once the run's cap is reached."""
    ck = url + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    if ck not in cache:
        if calls[src] >= cap:
            return None
        calls[src] += 1
        time.sleep(0.5)
        r = requests.get(url, params=params, headers={"X-API-Key": key}, timeout=20)
        cache[ck] = {"status": r.status_code, "body": r.json() if "json" in r.headers.get("content-type", "") else r.text[:300]}
        CACHE.write_text(json.dumps(cache))
        if r.status_code in (401, 402, 403, 429):  # bad key, paid-only or out of quota: stop spending
            calls[src] = cap
    return cache[ck]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def find(items, name):
    """Exact normalized name, else the shortest name that starts with ours (or ours with it)."""
    n = norm(name)
    exact = [i for i in items if norm(i["name"]) == n]
    loose = sorted((i for i in items if norm(i["name"]).startswith(n) or n.startswith(norm(i["name"]))), key=lambda i: len(i["name"]))
    return (exact or loose or [None])[0]


def carspecs(year, make, model):
    base, key = "https://carspecsapi.com/api/v2/cars", os.getenv("CARSPECS_API_KEY", "")
    makes = get("cs", f"{base}/makes", key, CS_MAX)
    if not makes or makes["status"] != 200:
        return "no makes: " + str(makes and makes["status"])
    mk = find(makes["body"]["data"], make)
    if not mk:
        return "make missing"
    models = get("cs", f"{base}/makes/{mk['id']}/models", key, CS_MAX)
    if not models:
        return "cap"
    md = find(models["body"].get("data", []), model)
    if not md:
        return "model missing"
    gens = get("cs", f"{base}/models/{md['id']}/generations", key, CS_MAX)
    if not gens:
        return "cap"
    hit = [g["name"] for g in gens["body"].get("data", []) if g["yearFrom"] <= year <= g.get("yearTo", 9999)]
    return f"ok: {md['name']} / {hit[0]}" if hit else "year missing"


def revcardata(year, make, model):
    r = get("rcd", "https://api.revcardata.com/api/v1/vehicles", os.getenv("REVCARDATA_API_KEY", ""), RCD_MAX - 6,
            make=make, model=model, year=year, region="US", limit=5)
    if not r:
        return "cap", []
    if r["status"] != 200:
        return f"http {r['status']}", []
    rows = r["body"].get("data", [])
    return (f"ok: {r['body'].get('total_found')} trims, e.g. {rows[0]['trim']}" if rows else "missing"), rows


session = get_session(init_db())
df = ListingRepository(session).get_active_listings_df()
counts = df.groupby(["year", "make", "model"]).size().sort_values(ascending=False)
top = counts.head(TOP_N)
print(f"Top {TOP_N} year/make/models = {top.sum():,} of {len(df):,} active listings ({top.sum() / len(df):.0%})\n")

hits = {"cs": 0, "rcd": 0}
samples = []
for (year, make, model), n in top.items():
    cs = carspecs(int(year), make, model)
    rcd, rows = revcardata(int(year), make, model)
    hits["cs"] += n if cs.startswith("ok") else 0
    hits["rcd"] += n if rcd.startswith("ok") else 0
    samples += rows[:1]
    print(f"{n:5d}  {year} {make} {model:<18} CarSpecsAPI: {cs:<40} RevCarData: {rcd}")

print(f"\nShare of those listings covered: CarSpecsAPI {hits['cs'] / top.sum():.0%}, RevCarData {hits['rcd'] / top.sum():.0%}")

# Does the free RevCarData key return actual specs, or only search results?
key = os.getenv("REVCARDATA_API_KEY", "")
for v in samples[:3]:
    for part in ("core", "premium"):
        r = get("rcd", f"https://api.revcardata.com/api/v1/vehicles/{v['id']}/{part}", key, RCD_MAX)
        print(f"\n{v['year']} {v['make']} {v['model']} {v['trim']} /{part}: ", json.dumps(r)[:500] if r else "cap")

print(f"\nNew calls this run: CarSpecsAPI {calls['cs']}, RevCarData {calls['rcd']}")
