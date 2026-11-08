"""
scraper/vehicle_specs.py — free NHTSA specs for the listing detail page.

Three free sources (research/car_specs_apis_research.md):
  - vPIC VIN decode: engine, safety equipment, curb weight, cached per VIN squish
  - vPIC Canadian specs: dimensions by year/make/model, in US units
  - NHTSA Safety Ratings: crash-test stars by year/make/model
These calls are NOT recorded in api_usage: month_total() sums every provider and
would eat the Marketcheck budget.
"""

import json
import time
from urllib.parse import quote

import requests
from loguru import logger
from sqlalchemy import func

from db.models import CarListing, ModelSpecs, VinSpecs

VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles"
RATINGS = "https://api.nhtsa.gov/SafetyRatings"
PAUSE_S = 0.5  # vPIC's rate limit is unpublished

# vPIC fields filled on 30%+ of a 50-VIN sample of our listings (2026-11-08).
# Wheel size, top speed, track width and steering were under 25%, so dropped.
VIN_FIELDS = [
    "EngineHP", "EngineConfiguration", "TransmissionStyle", "TransmissionSpeeds",
    "CurbWeightLB", "GVWR", "ABS", "ESC", "TractionControl", "TPMS",
    "AirBagLocFront", "AirBagLocSide", "AirBagLocCurtain", "AirBagLocKnee",
    "ForwardCollisionWarning", "CIB", "LaneDepartureWarning", "BlindSpotMon",
    "RearVisibilitySystem", "AdaptiveCruiseControl", "PlantCountry",
]
DIM_FIELDS = ["OL", "OW", "OH", "WB", "TWF", "TWR", "CW", "WD"]
RATING_FIELDS = ["OverallRating", "OverallFrontCrashRating", "OverallSideCrashRating", "RolloverRating"]
GROUPS = ["Safety & Security", "Engine", "Transmission & Drivetrain", "Fuel",
          "Steering", "Wheels & Tyres", "Dimensions & Weights", "Other"]
# Words NHTSA uses in variant names for each of our drivetrain values.
DRIVE_WORDS = {"4WD": {"4WD", "4X4"}, "AWD": {"AWD"}, "FWD": {"FWD", "2WD"}, "RWD": {"RWD", "2WD", "4X2"}}


def squish(vin: str) -> str:
    """Model, engine and year part of a VIN (drops check digit and serial)."""
    return vin[:8] + vin[9]


def _blank(v) -> bool:
    return v is None or str(v).strip() in ("", "nan", "None", "Not Applicable", "Not Rated")


def _get(url, **params):
    time.sleep(PAUSE_S)
    r = requests.get(url, params=params or None, timeout=15)
    r.raise_for_status()
    return r.json()


def decode_vins(vins: list[str]) -> dict:
    """One vPIC batch call (max 50 VINs) -> {squish: {field: value}}."""
    time.sleep(PAUSE_S)
    r = requests.post(f"{VPIC}/DecodeVINValuesBatch/", data={"format": "json", "data": ";".join(vins)}, timeout=30)
    r.raise_for_status()
    return {squish(row["VIN"]): {k: row[k] for k in VIN_FIELDS if not _blank(row.get(k))}
            for row in r.json()["Results"] if len(row.get("VIN") or "") == 17}


def model_specs(year: int, make: str, model: str) -> tuple[list, list, int]:
    """Canadian dimension groups and rated variants for one year/make/model.
    Retries with the model's first word ("Versa Sedan" -> "Versa").
    Returns (dims, ratings, calls made)."""
    calls, dims, ratings = 0, [], []
    for name in dict.fromkeys([model, model.split()[0]]):
        if not dims:
            calls += 1
            res = _get(f"{VPIC}/GetCanadianVehicleSpecifications/", year=year, make=make, model=name, units="US", format="json")
            dims = [{"name": next((s["Value"] for s in g["Specs"] if s["Name"] == "Model"), ""),
                     **{s["Name"]: s["Value"] for s in g["Specs"] if s["Name"] in DIM_FIELDS}}
                    for g in res.get("Results") or []]
        if not ratings:
            calls += 1
            variants = _get(f"{RATINGS}/modelyear/{year}/make/{quote(make, safe='')}/model/{quote(name, safe='')}").get("Results") or []
            for v in variants:
                calls += 1
                d = (_get(f"{RATINGS}/VehicleId/{v['VehicleId']}").get("Results") or [{}])[0]
                ratings.append({"name": v["VehicleDescription"], **{k: d.get(k) for k in RATING_FIELDS}})
    return dims, ratings, calls


def _pick(options: list[dict], words: set[str]):
    """The option whose name shares the most words with the listing; first on a tie."""
    return max(options, key=lambda o: len(words & set(o["name"].upper().replace("-", " ").split())), default={})


def _num(v, fmt):
    try:
        return fmt.format(float(v))
    except (TypeError, ValueError):
        return None


def build_spec_sheet(listing: dict, vin: dict, model: dict) -> list[dict]:
    """carsales-style groups [{"group", "rows": [[label, value]]}], empty rows and groups left out."""
    drive = (listing.get("drivetrain") or "").upper()
    words = set(f"{listing.get('trim') or ''} {listing.get('body_type') or ''}".upper().replace("-", " ").split())
    words |= DRIVE_WORDS.get(drive, set())
    dims = _pick(model.get("dims") or [], words)
    rating = _pick(model.get("ratings") or [], DRIVE_WORDS.get(drive, set()))
    stars = lambda k: None if _blank(rating.get(k)) else f"{rating[k]} / 5 stars"
    inches = lambda k: _num(dims.get(k), "{:.1f} in")
    wd = dims.get("WD") or ""

    rows = [
        ("Safety & Security", "NHTSA overall rating", stars("OverallRating")),
        ("Safety & Security", "Front crash rating", stars("OverallFrontCrashRating")),
        ("Safety & Security", "Side crash rating", stars("OverallSideCrashRating")),
        ("Safety & Security", "Rollover rating", stars("RolloverRating")),
        ("Safety & Security", "ABS", vin.get("ABS")),
        ("Safety & Security", "Stability control", vin.get("ESC")),
        ("Safety & Security", "Traction control", vin.get("TractionControl")),
        ("Safety & Security", "Tyre pressure monitoring", vin.get("TPMS")),
        ("Safety & Security", "Front airbags", vin.get("AirBagLocFront")),
        ("Safety & Security", "Side airbags", vin.get("AirBagLocSide")),
        ("Safety & Security", "Curtain airbags", vin.get("AirBagLocCurtain")),
        ("Safety & Security", "Knee airbags", vin.get("AirBagLocKnee")),
        ("Safety & Security", "Forward collision warning", vin.get("ForwardCollisionWarning")),
        ("Safety & Security", "Automatic emergency braking", vin.get("CIB")),
        ("Safety & Security", "Lane departure warning", vin.get("LaneDepartureWarning")),
        ("Safety & Security", "Blind spot monitoring", vin.get("BlindSpotMon")),
        ("Safety & Security", "Rear camera", vin.get("RearVisibilitySystem")),
        ("Safety & Security", "Adaptive cruise control", vin.get("AdaptiveCruiseControl")),
        ("Engine", "Power", _num(vin.get("EngineHP"), "{:.0f} hp")),
        ("Engine", "Engine size", _num(listing.get("engine_size"), "{:.1f} L")),
        ("Engine", "Cylinders", listing.get("cylinders")),
        ("Engine", "Layout", vin.get("EngineConfiguration")),
        ("Engine", "Powertrain", listing.get("powertrain_type")),
        ("Transmission & Drivetrain", "Transmission", vin.get("TransmissionStyle") or listing.get("transmission")),
        ("Transmission & Drivetrain", "Gears", vin.get("TransmissionSpeeds")),
        ("Transmission & Drivetrain", "Drive", listing.get("drivetrain")),
        ("Fuel", "Fuel type", listing.get("fuel_type")),
        ("Fuel", "City", _num(listing.get("city_mpg"), "{:.0f} mpg")),
        ("Fuel", "Highway", _num(listing.get("highway_mpg"), "{:.0f} mpg")),
        ("Dimensions & Weights", "Length", inches("OL")),
        ("Dimensions & Weights", "Width", inches("OW")),
        ("Dimensions & Weights", "Height", inches("OH")),
        ("Dimensions & Weights", "Wheelbase", inches("WB")),
        ("Dimensions & Weights", "Front track", inches("TWF")),
        ("Dimensions & Weights", "Rear track", inches("TWR")),
        ("Dimensions & Weights", "Curb weight", _num(vin.get("CurbWeightLB") or dims.get("CW"), "{:,.0f} lb")),
        ("Dimensions & Weights", "Weight distribution",
         "{}% front / {}% rear".format(*wd.split("/")) if wd.count("/") == 1 else None),
        ("Dimensions & Weights", "Gross vehicle weight rating", (vin.get("GVWR") or "").split(" (")[0]),
        ("Other", "Body", listing.get("body_type")),
        ("Other", "Doors", listing.get("doors")),
        ("Other", "Seats", listing.get("seats")),
        ("Other", "Built in", (vin.get("PlantCountry") or "").title().replace(" (Usa)", "")),
    ]
    sheet = {g: [] for g in GROUPS}
    for group, label, value in rows:
        if not _blank(value):
            sheet[group].append([label, str(value)])
    return [{"group": g, "rows": r} for g, r in sheet.items() if r]


def sheet_for(session, listing_id: str):
    """Spec sheet for one listing; None if the listing doesn't exist."""
    car = session.query(CarListing).filter_by(listing_id=listing_id).first()
    if car is None:
        return None
    vin_row = session.get(VinSpecs, squish(car.vin)) if car.vin and len(car.vin) == 17 else None
    model_row = session.query(ModelSpecs).filter_by(
        year=car.year, make=(car.make or "").lower(), model=(car.model or "").lower()).first()
    listing = {c.name: getattr(car, c.name) for c in CarListing.__table__.columns}
    vin = json.loads(vin_row.data) if vin_row else {}
    model = {"dims": json.loads(model_row.dims), "ratings": json.loads(model_row.ratings)} if model_row else {}
    if not (vin or model.get("dims") or model.get("ratings")):
        return []  # not fetched yet: a sheet of only our own few columns isn't worth showing
    return build_spec_sheet(listing, vin, model)


def fill_missing(session, max_calls: int | None = None) -> int:
    """Fetch specs for active listings that lack them, newest first. Returns calls made.
    Stops at max_calls, or after 5 failures in a row (NHTSA down: retry next run)."""
    calls = failures = 0
    def budget_left():
        return max_calls is None or calls < max_calls

    have = {s for (s,) in session.query(VinSpecs.squish)}
    todo = {}
    for (vin,) in (session.query(CarListing.vin).filter(CarListing.is_active == 1)
                   .order_by(CarListing.first_seen.desc())):
        if vin and len(vin) == 17 and squish(vin) not in have:
            todo.setdefault(squish(vin), vin)
    reps = list(todo.values())
    for i in range(0, len(reps), 50):
        if not budget_left() or failures >= 5:
            break
        batch = reps[i:i + 50]
        calls += 1
        try:
            decoded = decode_vins(batch)
            failures = 0
        except (requests.RequestException, ValueError, KeyError) as e:
            failures += 1
            logger.warning(f"vPIC batch decode failed: {e}")
            continue
        for vin in batch:  # undecodable VINs store {} so they aren't retried daily
            session.merge(VinSpecs(squish=squish(vin), data=json.dumps(decoded.get(squish(vin), {}))))
        session.commit()

    have_m = set(session.query(ModelSpecs.year, ModelSpecs.make, ModelSpecs.model))
    ymms = (session.query(CarListing.year, CarListing.make, CarListing.model)
            .filter(CarListing.is_active == 1, CarListing.year.isnot(None),
                    CarListing.make.isnot(None), CarListing.model.isnot(None))
            .group_by(CarListing.year, CarListing.make, CarListing.model)
            .order_by(func.max(CarListing.first_seen).desc()))
    for year, make, model in ymms:
        key = (year, make.lower(), model.lower())
        if key in have_m:
            continue
        if not budget_left() or failures >= 5:
            break
        try:
            dims, ratings, n = model_specs(year, make, model)
            calls += n
            failures = 0
        except (requests.RequestException, ValueError, KeyError) as e:
            calls += 1
            failures += 1
            logger.warning(f"NHTSA specs failed for {year} {make} {model}: {e}")
            continue
        have_m.add(key)
        session.add(ModelSpecs(year=key[0], make=key[1], model=key[2], dims=json.dumps(dims), ratings=json.dumps(ratings)))
        session.commit()
    return calls
