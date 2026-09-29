"""
scripts/holdout_audit.py — reproducible held-out evaluation of all four candidates.
Writes outputs/holdout_metrics.json. Saves no model (models/ is untouched).

Run: PYTHONPATH=. python3 scripts/holdout_audit.py [--as-of "YYYY-MM-DD HH:MM:SS"]

Retrains Linear / Relaxed Lasso / RF / XGBoost via ml.pipeline.train on
training_pool_v (one row per VIN) as of --as-of, default the newest last_seen
in the DB, so a given DB snapshot always yields the same rows. The split is
train/val/test grouped by VIN: selection and calibration use val only, every
number reported here is on test. rows_sha256 fingerprints the evaluated rows.
"""
import argparse, hashlib, json, platform, sys, warnings
from pathlib import Path

import numpy as np, pandas as pd, sklearn, xgboost
from sqlalchemy import text

from db.models import init_db, get_session, TRAINING_WINDOW_DAYS
from db.repository import ListingRepository
from ml import pipeline
from ml.pipeline import _vin_groups

warnings.filterwarnings("ignore")

OUT = Path("outputs/holdout_metrics.json")
SEGMENTS = {"<$10k": (0, 10_000), "$10-20k": (10_000, 20_000), "$20-35k": (20_000, 35_000),
            "$35-60k": (35_000, 60_000), ">$60k": (60_000, np.inf)}  # by TRUE price
N_BOOT, SEED = 2000, 42


def ape(pred, true):
    return np.abs(pred - true) / true * 100


def stats(pred, true):
    return {"n": int(len(true)), "mae": round(float(np.mean(np.abs(pred - true))), 1),
            "median_ape_pct": round(float(np.median(ape(pred, true))), 2)}


def boot(a: np.ndarray, b: np.ndarray, rng) -> dict:
    """95% percentile CIs for median APE of a, of b, and of a - b (paired: same resamples)."""
    idx = rng.integers(0, len(a), size=(N_BOOT, len(a)))
    ma, mb = np.median(a[idx], axis=1), np.median(b[idx], axis=1)
    ci = lambda x: [round(float(v), 2) for v in np.percentile(x, [2.5, 97.5])]
    d = ci(ma - mb)
    return {"xgb_ci95": ci(ma), "rf_ci95": ci(mb), "xgb_minus_rf": round(float(np.median(a) - np.median(b)), 2),
            "xgb_minus_rf_ci95": d, "difference_significant": not (d[0] <= 0 <= d[1])}


def main(as_of: str | None) -> dict:
    session = get_session(init_db())
    con = session.connection()
    if as_of is None:
        as_of = con.execute(text("select max(last_seen) from car_listings")).scalar()
    cutoff = str(pd.Timestamp(as_of) - pd.Timedelta(days=TRAINING_WINDOW_DAYS))
    df = pd.read_sql(text("select * from training_pool_v where last_seen >= :c order by id"), con,
                     params={"c": cutoff}, parse_dates=["first_seen", "last_seen"])

    result = pipeline.train(df, ListingRepository(session), model_path=None)
    if result is None:
        sys.exit("Training did not run (too few rows).")

    # --- split integrity: no car in two splits ---
    groups = _vin_groups(df).to_numpy()
    sets = {k: set(groups[v]) for k, v in result["split"].items()}
    overlap = {"train_val": len(sets["train"] & sets["val"]), "train_test": len(sets["train"] & sets["test"]),
               "val_test": len(sets["val"] & sets["test"])}
    assert sum(overlap.values()) == 0, f"VIN overlap across splits: {overlap}"

    yt, preds = result["y_test"], result["test_preds"]
    models = {}
    for name, p in preds.items():
        m = result["metrics"][name]
        models[name] = {"val_mae": round(m["val_mae"], 1), "log_calibration_from_val": round(m["log_calibration"], 4),
                        "test": stats(p, yt),
                        "test_segments": {lab: stats(p[(yt >= lo) & (yt < hi)], yt[(yt >= lo) & (yt < hi)])
                                          for lab, (lo, hi) in SEGMENTS.items()}}

    rng = np.random.default_rng(SEED)
    seg = (yt >= 20_000) & (yt < 35_000)
    a, b = ape(preds["xgb"], yt), ape(preds["rf"], yt)
    bootstrap = {"resamples": N_BOOT, "seed": SEED, "overall": boot(a, b, rng), "$20-35k": boot(a[seg], b[seg], rng)}

    val_winner = min(models, key=lambda k: models[k]["val_mae"])
    test_winner = min(models, key=lambda k: models[k]["test"]["median_ape_pct"])
    fingerprint = pd.util.hash_pandas_object(df[["id", "vin", "price", "mileage", "last_seen"]], index=False)

    return {
        "as_of": str(as_of), "training_window_days": TRAINING_WINDOW_DAYS,
        "rows_sha256": hashlib.sha256(fingerprint.to_numpy().tobytes()).hexdigest(),
        "split": {"method": "GroupShuffleSplit by VIN: test 20%, then val 20% of the rest (64/16/20)",
                  "seed": 42, "unique_vehicles": {k: len(s) for k, s in sets.items()},
                  "rows": {k: int(len(v)) for k, v in result["split"].items()},
                  "vins_in_more_than_one_split": overlap},
        "metric": "median_ape_pct = median(|pred - true| / true) * 100 on test; mae in $. "
                  "Predictions include the val-fitted calibration offset, as production serves them. "
                  "Segments filter on TRUE price.",
        "selected_model": result["selected_model"],
        "selection": {"rule": "lowest val MAE (uncalibrated)", "val_mae_winner": val_winner,
                      "test_median_ape_winner": test_winner, "agree": val_winner == test_winner},
        "models": models,
        "bootstrap_median_ape_xgb_vs_rf": bootstrap,
        "versions": {"python": platform.python_version(), "sklearn": sklearn.__version__,
                     "xgboost": xgboost.__version__, "numpy": np.__version__, "pandas": pd.__version__},
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", help="evaluate the training pool as of this UTC time (default: newest last_seen)")
    out = main(ap.parse_args().as_of)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out, indent=1))
