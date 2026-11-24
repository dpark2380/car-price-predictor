"""
scripts/specs_epa_import.py — Fill missing hp in engine_specs from the EPA's annual test car lists.
Run by hand: PYTHONPATH=. python3 scripts/specs_epa_import.py [--dry-run] [--check]

Files (epa.gov, public data), saved once in data/epa/ and read from there, nothing is fetched here:
https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy
lists one file per model year: xlsx for 2017 and later, csv for 2010-2016 (the 2000-2009 csv files use other
column names and cubic inches, so they are not read). The files carry rated horsepower, displacement and
cylinders per test vehicle; they carry no torque and no 0-60 time, so only hp is filled.

Only active cars that lack hp (no vPIC EngineHP, no engine_specs hp) are looked at. A config's hp is filled
only when every car in it matches EPA rows that agree (see match()); otherwise nothing is stored. Stored
hp is never overwritten, so VIN-decode and two-site search values always win. Hybrids and EVs are skipped:
EPA's rated hp for those is often the engine alone.
--check compares the EPA answer with the vPIC hp of cars that have one (accuracy test, writes nothing).
"""
import argparse
import csv
import glob
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

from db.models import CarListing, EngineSpecs, VinSpecs, init_db, get_session
from scraper.vehicle_specs import fuel_class, squish

DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "epa")
PAGE = "https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy"
TOL = 0.02  # candidates agree when max - min <= 2% of max
DRIVE_WORDS = {"4wd", "awd", "2wd", "fwd", "rwd", "4x4", "4x2"}
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def norm(s) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def model_key(s) -> str:
    """Model line without drive words: 'SILVERADO 4WD MUD TERRAIN TIRES' -> 'silveradomudterraintires'."""
    return "".join(t for t in re.findall(r"[a-z0-9]+", (s or "").lower()) if t not in DRIVE_WORDS)


def drive_group(s) -> str:
    s = (s or "").lower()
    return "awd" if "all wheel" in s or "awd" in s else "4wd" if "4-wheel" in s or "4wd" in s or "4x4" in s \
        else "fwd" if "front" in s or "fwd" in s else "rwd" if "rear" in s or "rwd" in s else ""


def match(cands, model, drive=None):
    """cands: EPA rows {model, hp, drive} already narrowed to one year, make, displacement, cylinders and fuel.
    Returns ("ok", hp), ("ambiguous", None) or ("none", None). A row matches when its model line equals the car's
    (a trailing class like '1500' on the car's side may be missing from EPA's; trim words must not differ). Matches must agree within
    TOL; if they do not, rows with the car's drive are tried before giving up."""
    m = model_key(model)
    names = {m, re.sub(r"(\d{4}|\d{3,4}hd)$", "", m)} - {""}
    rows = [c for c in cands if model_key(c["model"]) in names]
    if not rows:
        return "none", None
    for pool in (rows, [c for c in rows if drive and c["drive"] == drive_group(drive)]):
        hps = [c["hp"] for c in pool]
        if hps and max(hps) - min(hps) <= TOL * max(hps):
            return "ok", Counter(hps).most_common(1)[0][0]
    return "ambiguous", None


def searched_hps(row) -> set:
    """Distinct hp ratings the web search found for a stored config (its raw answer, either pass)."""
    raw = json.loads(row.raw or "{}") if row else {}
    return {r.get("hp") for a in (raw.get("answer"), (raw.get("v2") or {}).get("answer")) for r in (a or {}).get("ratings") or []} - {None}


def xlsx_rows(path):
    """Rows of the first sheet of an xlsx, read with the standard library (no openpyxl here)."""
    z = zipfile.ZipFile(path)
    ss = ["".join(t.text or "" for t in si.iter(NS + "t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml"))]
    for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(NS + "row"):
        out = []
        for c in row:
            i = 0
            for ch in re.match(r"[A-Z]+", c.get("r"))[0]:
                i = i * 26 + ord(ch) - 64
            out += [""] * (i - len(out))
            v = c.find(NS + "v")
            out[i - 1] = "" if v is None else ss[int(v.text)] if c.get("t") == "s" else v.text
        yield out


def load_epa() -> dict:
    """{(year, make, displacement L to 1 dp, cylinders, fuel): [{model, hp, drive}]} from data/epa/."""
    out = defaultdict(list)
    for path in sorted(glob.glob(os.path.join(DIR, "*tstcar*")) + glob.glob(os.path.join(DIR, "*testcar*"))):
        if not re.match(r"\d\d", os.path.basename(path)) or int(os.path.basename(path)[:2]) < 10:
            continue
        rows = xlsx_rows(path) if path.endswith(".xlsx") else csv.reader(open(path, encoding="latin-1", newline=""))
        head = next(rows)
        i = {k: head.index(k) for k in ("Model Year", "Represented Test Veh Make", "Represented Test Veh Model",
             "Test Veh Displacement (L)", "Rated Horsepower", "# of Cylinders and Rotors",
             "Drive System Description", "Test Fuel Type Description")}
        for r in rows:
            try:
                fuel_desc = r[i["Test Fuel Type Description"]].lower()
                if "electric" in fuel_desc or "hydrogen" in fuel_desc:
                    continue
                key = (int(r[i["Model Year"]]), norm(r[i["Represented Test Veh Make"]]),
                       round(float(r[i["Test Veh Displacement (L)"]]), 1), int(float(r[i["# of Cylinders and Rotors"]])),
                       "diesel" if "diesel" in fuel_desc else "gas")
                hp = int(float(r[i["Rated Horsepower"]]))
            except (ValueError, IndexError):
                continue
            if 40 <= hp <= 2000:
                out[key].append({"model": r[i["Represented Test Veh Model"]], "hp": hp,
                                 "drive": drive_group(r[i["Drive System Description"]])})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--check", action="store_true", help="compare with vPIC hp on cars that have one, write nothing")
    args = ap.parse_args()
    session = get_session(init_db())
    epa = load_epa()
    vpic = {s: json.loads(d or "{}").get("EngineHP") for s, d in session.query(VinSpecs.squish, VinSpecs.data)}
    stored = {(e.year, e.make, e.model, e.engine_size, e.fuel): e for e in session.query(EngineSpecs)}
    cars = defaultdict(list)  # config key -> [(cylinders, drivetrain, vpic hp)]
    n_lack = n_skipped = 0
    for vin, year, make, model, engine, cyl, fuel_type, powertrain, drive in session.query(
            CarListing.vin, CarListing.year, CarListing.make, CarListing.model, CarListing.engine_size, CarListing.cylinders,
            CarListing.fuel_type, CarListing.powertrain_type, CarListing.drivetrain).filter(CarListing.is_active == 1):
        key = (year, (make or "").lower().strip(), (model or "").lower().strip(), round(engine or 0, 1), fuel_class(fuel_type, powertrain))
        hp = vpic.get(squish(vin)) if vin and len(vin) == 17 else None
        have = hp or (stored[key].hp if key in stored else None)
        if args.check:
            if not hp:
                continue
            hp = int(float(hp))
        elif have:
            continue
        if not args.check:
            n_lack += 1
        if not (year and make and model and engine and engine > 0 and cyl and key[4] in ("gas", "diesel")):
            n_skipped += 1  # no engine size or cylinders, EV, hybrid, or fuel unknown
            continue
        cars[key].append((int(cyl), drive, hp if args.check else None))
    result = Counter()
    fills, diffs = {}, []
    for key, group in cars.items():
        year, make, model, engine, fuel = key
        outcomes = [match(epa.get((year, norm(make), engine, c, fuel), []), model, d) for c, d, _ in group]
        if args.check:
            for (status, hp), (_, _, truth) in zip(outcomes, group):
                result[status] += 1
                if status == "ok":
                    diffs.append((abs(hp - truth) / truth, key, hp, truth))
            continue
        statuses = {s for s, _ in outcomes}
        hps = {h for s, h in outcomes if s == "ok"}
        if statuses == {"ok"} and len(hps) == 1 and len(searched_hps(stored.get(key))) <= 1:  # web search saw several ratings: EPA may list only one
            fills[key] = hps.pop()
        else:
            result["ambiguous" if statuses & {"ambiguous"} or hps else "none"] += len(group)
    if args.check:
        good = sum(d[0] <= 0.05 for d in diffs)
        print(f"cars with vPIC hp: {sum(result.values())}; EPA match {result['ok']}, ambiguous {result['ambiguous']}, none {result['none']}")
        print(f"within 5%: {good} of {len(diffs)} = {good / max(len(diffs), 1):.1%}")
        for d, key, hp, truth in sorted(diffs, reverse=True)[:20]:
            print(f"  {key}: EPA {hp} vs vPIC {truth} ({d:.0%})")
        return
    n_fill = sum(len(cars[k]) for k in fills)
    print(f"active cars lacking hp: {n_lack}; skipped (no engine data, EV or hybrid): {n_skipped}")
    print(f"configs to fill: {len(fills)} covering {n_fill} cars; ambiguous cars: {result['ambiguous']}; no EPA match cars: {result['none']}")
    if args.dry_run:
        return
    for key, hp in fills.items():
        year, make, model, engine, fuel = key
        src = {"url": PAGE, "quote": f"EPA test car list {year}: rated horsepower {hp}"}
        raw = {"v": 2, "epa": {"hp": hp}}  # v 2 keeps specs_search_backfill --redo away from it
        row = stored.get(key)
        if row is None:
            session.add(EngineSpecs(year=year, make=make, model=model, engine_size=engine, fuel=fuel, hp=hp,
                                    sources=json.dumps([src]), raw=json.dumps(raw)))
        elif row.hp is None:  # never overwrite a stored value
            row.hp, row.sources = hp, json.dumps([src])
            row.raw = json.dumps({**json.loads(row.raw or "{}"), **raw})
    session.commit()
    print(f"stored hp for {len(fills)} configs")


if __name__ == "__main__":
    main()
