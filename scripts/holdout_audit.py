"""
scripts/holdout_audit.py — Held-out error, price-segment breakdown and deal-flag
rates for the saved model. Read-only.

Run: PYTHONPATH=. python3 scripts/holdout_audit.py [--candidates]

Reproduces ml/pipeline.py train()'s input + 80/20 split *as of the model's
training time*: reads training_pool_v and re-applies the last_seen window at
trained_at (training_listings_v's window rolls with 'now', so re-running the
split "now" silently mixes training rows into the test set). Asserts the
reproduced cohort stats equal the saved ones.
--candidates also refits linear / relaxed_lasso / rf on the same split.
"""
import json, sys, warnings
import numpy as np, pandas as pd, joblib
from sklearn.model_selection import train_test_split
from sqlalchemy import text
from db.models import init_db, TRAINING_WINDOW_DAYS
from ml.pipeline import (MODEL_PATH, _build_features_raw,
                         _kfold_cohort_encode, _apply_cohort_features, _deal_score_from_prices)
warnings.filterwarnings("ignore")

BUCKETS = [("<$10k", 0, 10_000), ("$10-20k", 10_000, 20_000), ("$20-35k", 20_000, 35_000),
           ("$35-60k", 35_000, 60_000), (">$60k", 60_000, np.inf)]  # same as pipeline.py tiers


def err_stats(pred, true):
    ape = np.abs(pred - true) / true * 100
    return {"n": int(len(true)), "mae": round(float(np.mean(np.abs(pred - true))), 1),
            "median_ape_%": round(float(np.median(ape)), 2), "mean_ape_%": round(float(np.mean(ape)), 2),
            "within_10pct_%": round(float(np.mean(ape <= 10) * 100), 1)}


def main(candidates: bool) -> dict:
    payload = joblib.load(MODEL_PATH)
    model, cal = payload["model"], payload["log_calibration"]
    trained_at = pd.to_datetime(payload["version"], format="%Y%m%d_%H%M")  # UTC

    con = init_db().connect()
    cutoff = {"cutoff": str(trained_at - pd.Timedelta(days=TRAINING_WINDOW_DAYS))}
    df = pd.read_sql(text("select * from training_pool_v where last_seen >= :cutoff order by id"),
                     con, params=cutoff)
    # score_job's (looser) input as of training time, for segment shares
    price_all = pd.read_sql(text("select price from car_listings where price > 500 and year is not null "
                                 "and mileage is not null and last_seen >= :cutoff"), con, params=cutoff).price.to_numpy()

    # --- same split as train() ---
    X_train, X_test, y_train, y_test = train_test_split(
        _build_features_raw(df), df["price"], test_size=0.2, random_state=42)
    X_train_enc, stats = _kfold_cohort_encode(X_train, y_train)
    if not stats.equals(payload["cohort_stats"]):
        sys.exit("Split not reproduced: DB changed since the model was trained (retrain, or restore the DB).")
    X_test = _apply_cohort_features(X_test, stats)
    yt = y_test.to_numpy()
    p_raw = np.expm1(model.predict(X_test))          # what train() logs
    p = np.expm1(model.predict(X_test) - cal)        # what production serves

    out = {"version": payload["version"], "rows": len(df), "test_rows": len(yt),
           "mae_reproduced": round(float(np.mean(np.abs(p_raw - yt))), 2),
           "mae_logged": round(payload["metrics"][payload["selected_model"]]["mae"], 2),
           "overall": err_stats(p, yt)}

    out["segments"] = {lab: err_stats(p[(yt >= lo) & (yt < hi)], yt[(yt >= lo) & (yt < hi)])
                       | {"share_of_all_scored_%": round(float(((price_all >= lo) & (price_all < hi)).mean() * 100), 1)}
                       for lab, lo, hi in BUCKETS}

    # --- deal flags (4 stars = score>=75 = asking >=20% under predicted; 5 stars = >=90 = >=32%) ---
    score = np.array([_deal_score_from_prices(a, b) for a, b in zip(yt, p)])
    p_tr = np.expm1(model.predict(_apply_cohort_features(X_train, stats)) - cal)
    score_tr = np.array([_deal_score_from_prices(a, b) for a, b in zip(y_train, p_tr)])
    rate = lambda s: {"4+_stars_%": round(float(np.mean(s >= 75) * 100), 2),
                      "5_stars_%": round(float(np.mean(s >= 90) * 100), 2)}
    out["flag_rate_heldout"] = rate(score)
    out["flag_rate_train_rows_insample"] = rate(score_tr)

    # Independent proxy: median of comparable TRAINING listings (same make/model,
    # year +/-1, mileage +/-25% (+5k), >=3 comps). No labelled "true deals" exist.
    tr = X_train[["make", "model", "year", "mileage"]].assign(price=y_train.to_numpy())
    groups = {k: g for k, g in tr.groupby(["make", "model"])}
    te = X_test[["make", "model", "year", "mileage", "cohort_count"]].assign(price=yt, score=score)

    def comp_median(r):
        g = groups.get((r.make, r.model))
        if g is None:
            return np.nan
        g = g[(g.year.sub(r.year).abs() <= 1) & g.mileage.between(r.mileage * 0.75, r.mileage * 1.25 + 5000)]
        return g.price.median() if len(g) >= 3 else np.nan

    te["comp"] = te.apply(comp_median, axis=1)
    below = (te.comp - te.price) / te.comp * 100

    def proxy(mask):
        b = below[mask & te.comp.notna()]
        return {"n": int(mask.sum()), "n_with_comps": int(len(b)),
                ">=10%_below_comps_%": round(float((b >= 10).mean() * 100), 1),
                ">=20%_below_comps_%": round(float((b >= 20).mean() * 100), 1),
                "thin_cohort(<5)_%": round(float((te.cohort_count[mask] < 5).mean() * 100), 1)}
    out["deal_proxy_4plus"] = proxy(te.score >= 75)
    out["deal_proxy_5star"] = proxy(te.score >= 90)
    out["deal_proxy_baseline_all"] = proxy(te.score > -1)

    if candidates:
        from sklearn.base import clone
        from sklearn.pipeline import Pipeline
        from sklearn.linear_model import LinearRegression
        from sklearn.ensemble import RandomForestRegressor
        from ml.pipeline import RelaxedLasso
        cands = {"linear": LinearRegression(), "relaxed_lasso": RelaxedLasso(cv=5, max_iter=10000, tol=1e-3),
                 "rf": RandomForestRegressor(n_estimators=300, random_state=42, n_jobs=-1, min_samples_leaf=2)}
        out["candidates"] = {payload["selected_model"] + " (saved)": err_stats(p_raw, yt)}
        for name, est in cands.items():
            if name == payload["selected_model"]:
                continue
            pipe = Pipeline([("preprocess", clone(model.named_steps["preprocess"])), ("model", est)])
            pipe.fit(X_train_enc, np.log1p(y_train))
            out["candidates"][name] = err_stats(np.expm1(pipe.predict(X_test)), yt)
    return out


if __name__ == "__main__":
    result = main("--candidates" in sys.argv)
    assert abs(result["mae_reproduced"] - result["mae_logged"]) < 1, "reproduced MAE != logged MAE"
    print(json.dumps(result, indent=1))
