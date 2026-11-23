"""
scripts/specs_decode_backfill.py — Fill missing hp / torque / 0-60 in engine_specs from MarketCheck's VIN decode.
Run by hand: PYTHONPATH=. python3 scripts/specs_decode_backfill.py [--limit 10] [--dry-run]

One call per config, using an active listing's VIN. Takes the STANDARD engine figures, then lets any
option-code entry override (the car was built with it). Only NULL fields are filled, never overwritten.
"""
import argparse
import json
from collections import defaultdict

from db.models import CarListing, EngineSpecs, init_db, get_session
from scraper.data_ingest import mc_get, extract  # extract is also imported from here by tests/test_specs_search.py
from scraper.vehicle_specs import fuel_class


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10, help="configs to decode this run")
    ap.add_argument("--dry-run", action="store_true", help="list what would be decoded, call nothing")
    args = ap.parse_args()
    session = get_session(init_db())
    rows = {(e.year, e.make, e.model, e.engine_size, e.fuel): e for e in session.query(EngineSpecs)
            if (e.hp is None or e.zero_to_sixty is None) and '"decode"' not in (e.raw or "")}  # one decode per config, ever
    n, vin = defaultdict(int), {}
    for v, year, make, model, engine, fuel_type, powertrain in session.query(
            CarListing.vin, CarListing.year, CarListing.make, CarListing.model, CarListing.engine_size,
            CarListing.fuel_type, CarListing.powertrain_type).filter(CarListing.is_active == 1, CarListing.engine_size > 0):
        k = (year, (make or "").lower().strip(), (model or "").lower().strip(), round(engine, 1), fuel_class(fuel_type, powertrain))
        if k in rows and v and len(v) == 17:
            n[k] += 1
            vin.setdefault(k, v)
    configs = sorted(vin, key=lambda k: (rows[k].hp is not None, -n[k]))[:args.limit]  # missing hp first
    fails = 0
    for i, k in enumerate(configs, 1):
        if args.dry_run:
            print(f"{i}/{len(configs)} {k} {n[k]} listings, would decode {vin[k]}")
            continue
        if fails >= 3:
            print("3 failed calls in a row, stopping")
            break
        try:
            vals, src = extract(mc_get(f"decode/car/neovin/{vin[k]}/specs", {}))
        except RuntimeError as e:
            fails += 1
            print(f"{i}/{len(configs)} {k}: failed ({e})")
            continue
        fails = 0
        row = rows[k]
        fill = {f: v for f, v in vals.items() if getattr(row, f) is None}
        for f, v in fill.items():
            setattr(row, f, v)
        row.raw = json.dumps({**json.loads(row.raw or "{}"), "decode": {"v": "neovin", "vin": vin[k], "vals": vals, "from": src}})
        session.commit()
        print(f"{i}/{len(configs)} {k}: decoded {vals}, filled {fill or '-'}", flush=True)


if __name__ == "__main__":
    main()
