"""
scripts/model_sanity_check.py — Sanity checks for the price prediction model.
Run: PYTHONPATH=. python3 scripts/model_sanity_check.py
"""
import numpy as np
import pandas as pd
from ml.pipeline import load, _build_features_raw, _apply_cohort_features

payload = load()
if payload is None:
    print("No model found. Run --train-only first.")
    exit(1)

model = payload["model"]
log_cal = payload.get("log_calibration", 0.0)
cohort_stats = payload.get("cohort_stats")
print(f"Model version: {payload['version']}")
print(f"Selected model: {payload['selected_model']}")
print(f"Log calibration: {log_cal:.4f}\n")

def predict(make, model_name, year, mileage, body_type="sedan", trim=""):
    row = {
        "make": make, "model": model_name, "year": year, "mileage": mileage,
        "body_type": body_type, "trim": trim,
        "price": 99999,  # dummy, not used in prediction
        "location_state": "", "location_zip": "",
    }
    df = pd.DataFrame([row])
    X = _build_features_raw(df)
    if cohort_stats is not None:
        X = _apply_cohort_features(X, cohort_stats)
    pred = float(np.expm1(model.predict(X)[0] - log_cal))
    return pred


# ── 1. Directional checks ────────────────────────────────────────────────────
# Lower mileage → higher price (same car, same year)
print("=" * 60)
print("1. MILEAGE EFFECT (2020 Toyota Camry — same year, different mileage)")
print("=" * 60)
for miles in [10_000, 50_000, 100_000, 150_000, 200_000]:
    p = predict("toyota", "camry", 2020, miles)
    print(f"  {miles:>7,} mi → ${p:>10,.0f}")

# Newer year → higher price (same mileage)
print("\n" + "=" * 60)
print("2. YEAR EFFECT (Toyota Camry 50k miles — different years)")
print("=" * 60)
for yr in [2012, 2015, 2018, 2020, 2022, 2024]:
    p = predict("toyota", "camry", yr, 50_000)
    print(f"  {yr} → ${p:>10,.0f}")

# Luxury vs non-luxury (similar size/year)
print("\n" + "=" * 60)
print("3. LUXURY PREMIUM (sedan, 2020, 40k miles)")
print("=" * 60)
cars = [
    ("toyota",        "camry",     "sedan"),
    ("honda",         "accord",    "sedan"),
    ("bmw",           "3 series",  "sedan"),
    ("mercedes-benz", "c-class",   "sedan"),
    ("lexus",         "es",        "sedan"),
]
for make, mdl, body in cars:
    p = predict(make, mdl, 2020, 40_000, body_type=body)
    print(f"  {make:<15} {mdl:<12} → ${p:>10,.0f}")

# ── 2. Absolute price sanity ─────────────────────────────────────────────────
print("\n" + "=" * 60)
print("4. ABSOLUTE PRICE SANITY (are predictions in a plausible range?)")
print("=" * 60)
checks = [
    ("honda",   "civic",   2018, 60_000,  "Expected $12k–$18k"),
    ("ford",    "f-150",   2020, 40_000,  "Expected $30k–$45k"),
    ("tesla",   "model 3", 2022, 20_000,  "Expected $30k–$45k"),
    ("bmw",     "x5",      2019, 50_000,  "Expected $35k–$55k"),
    ("toyota",  "corolla", 2010, 120_000, "Expected $6k–$12k"),
]
for make, mdl, yr, mi, note in checks:
    p = predict(make, mdl, yr, mi)
    print(f"  {yr} {make} {mdl:<12} {mi:>7,}mi → ${p:>9,.0f}   {note}")

# ── 3. Residual distribution on scored DB listings ────────────────────────────
print("\n" + "=" * 60)
print("5. RESIDUAL DISTRIBUTION (scored listings in DB)")
print("=" * 60)
try:
    from db.models import init_db, get_session
    from db.repository import ListingRepository, PredictionRepository

    session = get_session(init_db())
    listings = ListingRepository(session).get_active_listings_df()
    preds    = PredictionRepository(session).get_top_deals(limit=99999, min_deal_score=0)
    df = listings.merge(preds[["listing_id", "predicted_price"]], on="listing_id", how="inner")
    df["residual"] = df["predicted_price"] - df["price"]
    df["pct_error"] = df["residual"] / df["price"] * 100

    print(f"  Total listings:      {len(df)}")
    print(f"  Predicted > actual:  {(df['residual'] > 0).sum()} ({(df['residual'] > 0).mean()*100:.1f}%)")
    print(f"  Predicted < actual:  {(df['residual'] < 0).sum()} ({(df['residual'] < 0).mean()*100:.1f}%)")
    print(f"\n  Residual ($) stats:")
    for stat, val in df["residual"].describe().items():
        print(f"    {stat:<8} ${val:>10,.0f}")
    print(f"\n  % error stats:")
    for stat, val in df["pct_error"].describe().items():
        print(f"    {stat:<8} {val:>8.1f}%")
except Exception as e:
    print(f"  Could not load DB: {e}")
