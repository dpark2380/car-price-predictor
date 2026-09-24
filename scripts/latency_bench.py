"""
scripts/latency_bench.py — p50/p95 latency of the API endpoints and time for a
full rescoring pass. Read-only (rescoring is timed without saving).

Start the API first (same server as production):  PORT=5057 PYTHONPATH=. python3 start.py
Then run:  API_BASE=http://127.0.0.1:5057/api PYTHONPATH=. python3 scripts/latency_bench.py
Sequential single client on localhost: no network, no concurrency.
"""
import json, os, sqlite3, time
from urllib.parse import urlencode
import numpy as np, pandas as pd, requests
from ml.pipeline import score_listings

BASE = os.environ.get("API_BASE", "http://127.0.0.1:5057/api")
s = requests.Session()


def bench(name, urls, warm=10):
    for u in urls[:warm]:
        s.get(u)
    t = []
    for u in urls:
        a = time.perf_counter()
        r = s.get(u)
        t.append((time.perf_counter() - a) * 1000)
        r.raise_for_status()
    return {"endpoint": name, "n": len(t), "p50_ms": round(float(np.percentile(t, 50)), 1),
            "p95_ms": round(float(np.percentile(t, 95)), 1)}


con = sqlite3.connect("car_intel.db")
cars = pd.read_sql("select make, model, year, mileage, trim, location_state from car_listings "
                   "order by random() limit 300", con)
predict_urls = [f"{BASE}/predict?" + urlencode({"make": r.make, "model": r.model, "year": int(r.year),
                "mileage": int(r.mileage), "trim": r.trim or "", "state": r.location_state or ""})
                for r in cars.itertuples()]
out = [bench("/api/predict", predict_urls),
       bench("/api/deals (limit=100)", [f"{BASE}/deals"] * 300),
       bench("/api/deals?limit=10000 (dashboard)", [f"{BASE}/deals?limit=10000&min_score=0"] * 100, warm=3)]

df = pd.read_sql("select * from car_listings", con)
runs = []
for _ in range(5):
    a = time.perf_counter()
    n = len(score_listings(df))
    runs.append(time.perf_counter() - a)
out.append({"rescore_listings": n, "score_listings_s_median_of_5": round(float(np.median(runs)), 2)})
print(json.dumps(out, indent=1))
