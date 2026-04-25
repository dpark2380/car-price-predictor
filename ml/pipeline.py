import os
import warnings
import joblib
import numpy as np
import pandas as pd
from datetime import datetime
from loguru import logger

# market_median_price / market_dom_median / price_to_market are optional enrichment
# features that are intentionally all-NaN when MarketCheck API calls are disabled.
# Suppress the imputer warning that fires once per tree for these columns.
warnings.filterwarnings(
    "ignore",
    message="Skipping features without any observed values",
    category=UserWarning,
    module="sklearn",
)

from sklearn.model_selection import train_test_split, KFold, GridSearchCV
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
from sklearn.inspection import permutation_importance


try:
    from xgboost import XGBRegressor
    HAS_XGB = True
except ImportError:
    HAS_XGB = False
    logger.warning("XGBoost not installed — using sklearn fallback")
    from sklearn.ensemble import GradientBoostingRegressor

from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer

MODEL_PATH = "models/price_predictor.joblib"
MIN_TRAINING_SAMPLES = int(os.getenv("MIN_TRAINING_SAMPLES", 140))
TRIM_RANKINGS_PATH = "config/trim_rankings.json"

import json as _json
def _load_trim_rankings() -> dict:
    try:
        with open(TRIM_RANKINGS_PATH) as f:
            data = _json.load(f)
        return {k: v for k, v in data.items() if not k.startswith("_")}
    except Exception:
        return {}

_TRIM_RANKINGS = _load_trim_rankings()


def _trim_rank(make: str, trim: str) -> float:
    """
    Look up a numeric trim rank for a given make + trim string.
    Matches longest keyword first to avoid 'turbo' beating 'turbo s'.
    Returns 2.0 (mid-range default) if make not in rankings or no keyword matches.
    """
    make_map = _TRIM_RANKINGS.get(make.lower().strip(), {})
    if not make_map:
        return 2.0
    trim_lower = str(trim).lower().strip() if trim and trim == trim else ""
    # Sort by keyword length descending so longer/more specific keywords win
    for keyword in sorted(make_map, key=len, reverse=True):
        if keyword in trim_lower:
            return float(make_map[keyword])
    return 2.0


def _build_features_raw(df: pd.DataFrame) -> pd.DataFrame:
    """
    Build a feature frame with a mix of numeric and categorical columns.
    Categorical columns are kept as strings so they can be OneHotEncoded safely.
    """
    now_year = datetime.utcnow().year
    out = pd.DataFrame(index=df.index)

    def _norm_str(s: pd.Series) -> pd.Series:
        return (
            s.astype(str)
            .str.lower()
            .str.strip()
            .replace({"nan": "", "none": "", "null": ""})
        )

    # --- numeric ---
    out["year"] = pd.to_numeric(df["year"], errors="coerce")
    out["vehicle_age"] = (now_year - out["year"]).clip(0, 50)  # guardrails

    out["mileage"] = pd.to_numeric(df["mileage"], errors="coerce").clip(0, 600_000)
    out["miles_per_year"] = (out["mileage"] / (out["vehicle_age"].clip(1))).clip(0, 60_000)

    # Nonlinear transforms (helps luxury depreciation a LOT)
    out["log_mileage"] = np.log1p(out["mileage"])
    out["log_age"] = np.log1p(out["vehicle_age"])
    out["age_sq"] = (out["vehicle_age"] ** 2).clip(0, 2500)

    out["accident_count"] = pd.to_numeric(df.get("accident_count", 0), errors="coerce").fillna(0)
    out["owner_count"] = pd.to_numeric(df.get("owner_count", 1), errors="coerce").fillna(1)

    # --- categoricals (strings) ---
    out["make"] = df["make"].astype(str).str.lower().str.strip()
    out["model"] = df["model"].astype(str).str.lower().str.strip()
    out["state"] = (
        df.get("location_state", pd.Series([""] * len(df), index=df.index))
        .astype(str).str.upper().str.strip()
    )

    # --- simple flags ---
    luxury_makes = {
        "bmw", "mercedes-benz", "mercedes", "lexus", "audi", "acura", "infiniti", "cadillac",
        "lincoln", "porsche", "jaguar", "land rover", "volvo", "genesis",
        "tesla", "rivian", "lucid",
        "bentley", "rolls-royce", "lamborghini", "ferrari", "mclaren", "maserati",
    }
    truck_keywords = {"f-150", "f-250", "f-350", "silverado", "sierra", "ram", "tundra", "tacoma", "ranger", "colorado"}
    sports_keywords = {"corvette", "mustang", "camaro", "challenger", "charger", "86", "brz", "miata", "supra", "911", "cayman"}

    make_s = out["make"]
    model_s = out["model"]

    out["is_luxury"] = make_s.isin(luxury_makes).astype(float)
    out["is_truck"] = model_s.apply(lambda m: float(any(t in m for t in truck_keywords)))
    out["is_sports"] = model_s.apply(lambda m: float(any(s in m for s in sports_keywords)))

    # Luxury interaction features (forces model to learn steeper depreciation curve)
    out["lux_age"] = out["is_luxury"] * out["vehicle_age"]
    out["lux_mpy"] = out["is_luxury"] * out["miles_per_year"]

    # --- extra categoricals (safe fallback to "")
    out["trim"]         = _norm_str(df.get("trim", pd.Series([""] * len(df), index=df.index)))
    out["trim_rank"]    = [
        _trim_rank(m, t) for m, t in zip(out["make"], out["trim"])
    ]
    out["body_type"]    = _norm_str(df.get("body_type", pd.Series([""] * len(df), index=df.index)))
    out["drivetrain"]   = _norm_str(df.get("drivetrain", pd.Series([""] * len(df), index=df.index)))
    out["fuel_type"]    = _norm_str(df.get("fuel_type", pd.Series([""] * len(df), index=df.index)))
    out["transmission"] = _norm_str(df.get("transmission", pd.Series([""] * len(df), index=df.index)))

    out["zip3"] = (
        df.get("location_zip", pd.Series([""] * len(df), index=df.index))
        .astype(str)
        .str.strip()
        .str[:3]
        .replace({"": "000"})
    )

    # --- market benchmark features (from sales stats cache, may be NaN if not enriched) ---
    out["market_median_price"] = pd.to_numeric(
        df.get("market_median_price", pd.Series([np.nan] * len(df), index=df.index)),
        errors="coerce",
    )
    out["market_dom_median"] = pd.to_numeric(
        df.get("market_dom_median", pd.Series([np.nan] * len(df), index=df.index)),
        errors="coerce",
    )
    # How over/under market is this listing (1.0 = at market, <1 = below, >1 = above)
    raw_price = pd.to_numeric(df.get("price", pd.Series([np.nan] * len(df), index=df.index)), errors="coerce")
    out["price_to_market"] = (raw_price / out["market_median_price"].replace(0, np.nan)).clip(0, 5)

    return out


def _compute_cohort_stats(X: pd.DataFrame, y: pd.Series) -> pd.DataFrame:
    """
    Compute median price and listing count per (make, model, year) cohort
    from training data only. Used to build market-relative features without
    any external API calls.
    """
    src = X[["make", "model", "year"]].copy()
    src["_price"] = y.to_numpy()
    return (
        src.groupby(["make", "model", "year"])["_price"]
        .agg(cohort_median="median", cohort_count="count")
    )


def _apply_cohort_features(X: pd.DataFrame, cohort_stats: pd.DataFrame) -> pd.DataFrame:
    """
    Join cohort median price and count onto X by (make, model, year).
    Missing cohorts get NaN/0 — the pipeline imputer handles these gracefully.
    """
    X = X.copy()
    keys = pd.MultiIndex.from_arrays([X["make"], X["model"], X["year"]])
    X["cohort_median_price"] = cohort_stats["cohort_median"].reindex(keys).to_numpy()
    X["cohort_count"] = cohort_stats["cohort_count"].reindex(keys).fillna(0).to_numpy().astype(float)
    return X


def _kfold_cohort_encode(
    X: pd.DataFrame, y: pd.Series, n_splits: int = 5
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Compute cohort_median_price and cohort_count for each training row using
    k-fold target encoding to prevent leakage.

    For each row, the cohort median is computed from the other k-1 folds —
    so no row ever sees its own price when its cohort feature is computed.

    Also returns full_cohort_stats (computed from all training data), which is
    saved in the model payload and used at inference time (score_listings,
    /api/predict) where there is no leakage concern.
    """
    X = X.copy()
    cohort_median = np.full(len(X), np.nan)
    cohort_count  = np.zeros(len(X))

    kf = KFold(n_splits=n_splits, shuffle=True, random_state=42)
    arr_y = y.to_numpy()

    for train_idx, val_idx in kf.split(X):
        fold_stats = _compute_cohort_stats(X.iloc[train_idx], y.iloc[train_idx])
        keys = pd.MultiIndex.from_arrays([
            X.iloc[val_idx]["make"],
            X.iloc[val_idx]["model"],
            X.iloc[val_idx]["year"],
        ])
        cohort_median[val_idx] = fold_stats["cohort_median"].reindex(keys).to_numpy()
        cohort_count[val_idx]  = fold_stats["cohort_count"].reindex(keys).fillna(0).to_numpy()

    X["cohort_median_price"] = cohort_median
    X["cohort_count"]        = cohort_count.astype(float)

    # Full cohort stats for inference — saved in model payload
    full_cohort_stats = _compute_cohort_stats(X.drop(columns=["cohort_median_price", "cohort_count"]), y)

    return X, full_cohort_stats


def train(df: pd.DataFrame) -> dict | None:
    logger.info("Starting model training run…")

    # -----------------------------
    # 1) Clean + filter
    # -----------------------------
    df = df.dropna(subset=["price", "mileage", "year", "make", "model"]).copy()
    df["price"] = pd.to_numeric(df["price"], errors="coerce")
    df["mileage"] = pd.to_numeric(df["mileage"], errors="coerce")
    df["year"] = pd.to_numeric(df["year"], errors="coerce")

    df = df.dropna(subset=["price", "mileage", "year"])
    df = df[df["price"].between(3_000, 100_000)]
    df = df[df["mileage"].between(0, 400_000)]

    if len(df) < MIN_TRAINING_SAMPLES:
        logger.warning(f"Not enough data to train ({len(df)} rows, need {MIN_TRAINING_SAMPLES})")
        return None

    # -----------------------------
    # 2) Build features + split
    # -----------------------------
    X_raw = _build_features_raw(df)
    y = df["price"]

    X_train, X_test, y_train, y_test = train_test_split(
        X_raw, y, test_size=0.2, random_state=42
    )

    # K-fold cohort encoding — no leakage, full stats saved for inference
    X_train, full_cohort_stats = _kfold_cohort_encode(X_train, y_train)
    X_test = _apply_cohort_features(X_test, full_cohort_stats)

    # log-space targets (this is what we train on)
    y_train_log = np.log1p(y_train)
    y_test_log = np.log1p(y_test)

    # -----------------------------
    # 3) Preprocess
    # -----------------------------
    numeric_features = [
        "year", "vehicle_age", "age_sq", "log_age",
        "mileage", "log_mileage", "miles_per_year",
        "accident_count", "owner_count",
        "is_luxury", "is_truck", "is_sports",
        "lux_age", "lux_mpy",
        "trim_rank",
        "market_median_price", "market_dom_median", "price_to_market",
        "cohort_median_price", "cohort_count",
    ]
    categorical_features = [
        "make", "model", "state",
        "trim", "body_type", "drivetrain", "fuel_type", "transmission", "zip3",
    ]

    numeric_transformer = Pipeline(steps=[
        ("imputer", SimpleImputer(strategy="median")),
    ])

    categorical_transformer = Pipeline(steps=[
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("onehot", OneHotEncoder(handle_unknown="ignore")),
    ])

    preprocess = ColumnTransformer(
        transformers=[
            ("num", numeric_transformer, numeric_features),
            ("cat", categorical_transformer, categorical_features),
        ],
        remainder="drop",
    )

    # -----------------------------
    # 4) Candidates
    # -----------------------------
    candidates: dict[str, object] = {
        "linear": LinearRegression(),
        "rf": RandomForestRegressor(
            n_estimators=300,
            random_state=42,
            n_jobs=-1,
            min_samples_leaf=2,
        ),
    }

    if HAS_XGB:
        # Joint grid search over M (n_estimators) and eta (learning_rate).
        # These two are not independent: small eta needs many trees to converge,
        # large eta converges faster but may overshoot. Searching them jointly
        # finds the true optimum rather than two separate marginal optima.
        _base_xgb = XGBRegressor(
            max_depth=6,
            subsample=0.8,
            colsample_bytree=0.7,
            min_child_weight=3,
            gamma=0.05,
            reg_alpha=0.05,
            reg_lambda=1.0,
            random_state=42,
            verbosity=0,
            objective="reg:absoluteerror",
        )
        _gs_pipe = Pipeline(steps=[
            ("preprocess", preprocess),
            ("model", _base_xgb),
        ])
        _param_grid = {
            "model__learning_rate": [0.01, 0.03, 0.05, 0.1],
            "model__n_estimators":  [500, 1000, 1500, 2000],
        }
        logger.info("Running XGB grid search (4×4 grid, 5-fold CV = 80 fits)…")
        _gs = GridSearchCV(
            _gs_pipe,
            _param_grid,
            cv=5,
            scoring="neg_mean_absolute_error",
            n_jobs=-1,
            refit=False,
            verbose=0,
        )
        _gs.fit(X_train, y_train_log)
        _best = _gs.best_params_
        logger.info(
            f"XGB grid search best: learning_rate={_best['model__learning_rate']}, "
            f"n_estimators={_best['model__n_estimators']}  "
            f"(CV MAE log={-_gs.best_score_:.4f})"
        )

        # Early stopping: find the true optimal n_estimators given the best lr.
        # The grid search ceiling (2000) may be too low or higher than needed —
        # early stopping on a held-out slice tells us exactly when to stop.
        _X_tr_es, _X_val_es, _y_tr_es, _y_val_es = train_test_split(
            X_train, y_train_log, test_size=0.15, random_state=0
        )
        _pre_es = clone(preprocess)
        _pre_es.fit(X_train)  # fit on full X_train so OHE sees all categories
        _xgb_es = XGBRegressor(
            n_estimators=3000,
            learning_rate=_best["model__learning_rate"],
            max_depth=6,
            subsample=0.8,
            colsample_bytree=0.7,
            min_child_weight=3,
            gamma=0.05,
            reg_alpha=0.05,
            reg_lambda=1.0,
            random_state=42,
            verbosity=0,
            objective="reg:absoluteerror",
            early_stopping_rounds=50,
            eval_metric="mae",
        )
        _xgb_es.fit(
            _pre_es.transform(_X_tr_es),
            _y_tr_es,
            eval_set=[(_pre_es.transform(_X_val_es), _y_val_es)],
            verbose=False,
        )
        _optimal_n = _xgb_es.best_iteration
        logger.info(
            f"Early stopping: optimal n_estimators={_optimal_n} "
            f"(ceiling=3000, grid search suggested {_best['model__n_estimators']})"
        )

        candidates["xgb"] = XGBRegressor(
            n_estimators=_optimal_n,
            learning_rate=_best["model__learning_rate"],
            max_depth=6,
            subsample=0.8,
            colsample_bytree=0.7,
            min_child_weight=3,
            gamma=0.05,
            reg_alpha=0.05,
            reg_lambda=1.0,
            random_state=42,
            verbosity=0,
            objective="reg:absoluteerror",
        )

    sample_weight = np.ones(len(X_train))

    def _eval(y_true_np: np.ndarray, y_pred_np: np.ndarray) -> tuple[float, float]:
        mae = float(mean_absolute_error(y_true_np, y_pred_np))
        rmse = float(np.sqrt(mean_squared_error(y_true_np, y_pred_np)))
        return mae, rmse

    fitted: dict[str, Pipeline] = {}
    metrics: dict[str, dict] = {}

    # -----------------------------
    # 5) Train + evaluate each candidate
    # -----------------------------
    for name, model in candidates.items():
        pipe = Pipeline(steps=[
            ("preprocess", preprocess),
            ("model", model),
        ])

        pipe.fit(X_train, y_train_log, model__sample_weight=sample_weight)

        # ---- training RMSE (log-space) for ALL models (works consistently) ----
        pred_train_log = pipe.predict(X_train)
        train_rmse_log = float(np.sqrt(mean_squared_error(y_train_log.to_numpy(), pred_train_log)))

        # ---- test metrics in $ space ----
        pred_test = np.expm1(pipe.predict(X_test))
        y_true = y_test.to_numpy()
        mae, rmse = _eval(y_true, pred_test)

        # slice MAE: luxury vs non-lux
        test_is_lux = (X_test["is_luxury"].to_numpy() >= 0.5)
        lux_n = int(test_is_lux.sum())
        nonlux_n = int((~test_is_lux).sum())

        lux_mae = float(np.mean(np.abs(pred_test[test_is_lux] - y_true[test_is_lux]))) if lux_n > 0 else float("nan")
        nonlux_mae = float(np.mean(np.abs(pred_test[~test_is_lux] - y_true[~test_is_lux]))) if nonlux_n > 0 else float("nan")

        fitted[name] = pipe
        metrics[name] = {
            "mae": mae,
            "rmse": rmse,
            "train_rmse_log": train_rmse_log,
            "luxury_n": lux_n,
            "nonlux_n": nonlux_n,
            "luxury_mae": lux_mae,
            "nonlux_mae": nonlux_mae,
        }

        logger.info(
            f"Candidate {name} | MAE=${mae:,.0f} RMSE=${rmse:,.0f} | "
            f"trainRMSE(log)={train_rmse_log:.4f} | "
            f"luxury=${lux_mae:,.0f} (n={lux_n}) nonlux=${nonlux_mae:,.0f} (n={nonlux_n})"
        )

    # pick best by MAE
    best_name = min(metrics.keys(), key=lambda k: metrics[k]["mae"])
    pipe = fitted[best_name]
    best = metrics[best_name]

    logger.info(f"Selected model: {best_name} | MAE=${best['mae']:,.0f} RMSE=${best['rmse']:,.0f}")

    # -----------------------------
    # 6) Calibration — correct systematic bias in log space
    # -----------------------------
    # Compute median residual on training set. Subtracting this from future
    # log-space predictions ensures the median training error is zero, giving
    # a balanced mix of positive and negative savings at scoring time.
    test_log_preds = pipe.predict(X_test)
    log_calibration = float(np.median(test_log_preds - y_test_log.to_numpy()))
    direction = "over" if log_calibration > 0 else "under"
    logger.info(
        f"Calibration offset (log, test set): {log_calibration:.4f}  "
        f"(≈ {abs(np.expm1(-abs(log_calibration)) * 100):.1f}% systematic {direction}prediction corrected)"
    )

    # -----------------------------
    # 7) Permutation importance on RAW features (24 cols)
    # -----------------------------
    try:
        pi = permutation_importance(
            pipe,
            X_test,                  # raw features
            y_test_log,              # log target (matches training)
            n_repeats=5,
            random_state=42,
            n_jobs=-1,
            scoring="neg_mean_absolute_error",
        )

        imp = (
            pd.Series(pi.importances_mean, index=X_test.columns)
            .sort_values(ascending=False)
        )
        logger.info("Top permutation importances (raw features):\n" + imp.head(20).to_string())

    except Exception as e:
        logger.warning(f"Permutation importance failed: {e}")

    # -----------------------------
    # 7) Save
    # -----------------------------
    version = datetime.utcnow().strftime("%Y%m%d_%H%M")
    payload = {
        "model": pipe,
        "version": version,
        "selected_model": best_name,
        "metrics": metrics,
        "log_calibration": log_calibration,
        "cohort_stats": full_cohort_stats,
    }

    os.makedirs("models", exist_ok=True)
    joblib.dump(payload, MODEL_PATH)

    logger.info("\n" + "="*72)
    logger.info(f"MODEL TRAINING SUMMARY  |  Version: {version}")
    logger.info("="*72)

    for name, m in metrics.items():
        logger.info(
            f"{name.upper():<8} | "
            f"MAE=${m['mae']:>8,.0f}  "
            f"RMSE=${m['rmse']:>8,.0f}  "
            f"TrainRMSE(log)={m['train_rmse_log']:.4f}"
        )
        logger.info(
            f"          Luxury MAE=${m['luxury_mae']:>8,.0f} (n={m['luxury_n']})  "
            f"Non-Lux MAE=${m['nonlux_mae']:>8,.0f} (n={m['nonlux_n']})"
        )
        logger.info("-"*72)

    logger.info(f"SELECTED MODEL → {best_name.upper()}")
    logger.info(f"Rows after cleaning: {len(df)}")
    logger.info(f"Train rows: {len(X_train)} | Test rows: {len(X_test)}")
    logger.info(f"Train/Test split: {len(X_train)}/{len(X_test)}")
    logger.info("="*72 + "\n")

    return {
        "version": version,
        "selected_model": best_name,
        "metrics": metrics,
        "n": int(len(df)),
    }


def load() -> dict | None:
    if not os.path.exists(MODEL_PATH):
        return None
    payload = joblib.load(MODEL_PATH)
    logger.info(f"Loaded model v{payload.get('version', '?')}")
    return payload


# ----------------------------
# Deal score: 0–100 (100 best)
# ----------------------------

def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def _deal_score_from_prices(actual: float, predicted: float) -> float:
    """
    Map pricing gap to a stable 0–100 score.

    Let diff_pct = (predicted - actual) / predicted * 100
      - diff_pct > 0  => under market (good)
      - diff_pct < 0  => over market (bad)

    We map:
      diff_pct = +20%  -> 100
      diff_pct =   0%  -> 50
      diff_pct = -20%  -> 0
    and clamp beyond ±20%.
    """
    if predicted <= 0:
        return 50.0

    diff_pct = (predicted - actual) / predicted * 100.0  # + = good
    score = 50.0 + (diff_pct * 1.25)
    return _clamp(score, 0.0, 100.0)


def _deal_label(score: float) -> str:
    if score >= 90:
        return "5 Stars"
    if score >= 75:
        return "4 Stars"
    if score >= 60:
        return "3 Stars"
    if score >= 45:
        return "2 Stars"
    return "1 Star"


def score_listings(df: pd.DataFrame) -> list[dict]:
    """
    Produces a 0–100 deal_score where:
      - 100 = best deal (most under market)
      - 50  = fair price
      - 0   = worst deal (most over market)
    """
    payload = load()
    if payload is None:
        logger.warning("No model found — cannot score")
        return []

    model = payload["model"]

    df = df.copy()
    df = df.dropna(subset=["price", "mileage", "year", "make", "model"])
    if df.empty:
        return []

    df["price"] = pd.to_numeric(df["price"], errors="coerce")
    df = df.dropna(subset=["price"])
    if df.empty:
        return []

    logger.info(f"Scoring {len(df)} listings…")
    X = _build_features_raw(df)
    cohort_stats = payload.get("cohort_stats")
    if cohort_stats is not None:
        X = _apply_cohort_features(X, cohort_stats)
    log_calibration = payload.get("log_calibration", 0.0)
    preds = np.expm1(model.predict(X) - log_calibration)

    # Keep alignment with df rows
    df = df.reset_index(drop=True)

    results: list[dict] = []
    for i, row in df.iterrows():
        predicted = float(preds[i])
        actual = float(row["price"])
        if not np.isfinite(predicted) or predicted <= 0:
            continue
        if not np.isfinite(actual) or actual <= 0:
            continue

        score = _deal_score_from_prices(actual=actual, predicted=predicted)
        score = round(score, 1)

        results.append(
            {
                "listing_id": row.get("listing_id"),
                "predicted_price": round(predicted, 2),
                "deal_score": score,
                "deal_label": _deal_label(score),
                "model_version": payload.get("version", "unknown"),
            }
        )

    logger.info(f"Scored and saved {len(results)} predictions")
    return results


def update_popularity_snapshot(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []

    cohorts = (
        df.groupby(["year", "make", "model"])
        .agg(
            active_listings=("listing_id", "count"),
            avg_price=("price", "mean"),
            median_price=("price", "median"),
            avg_mileage=("mileage", "mean"),
            avg_days_listed=("days_listed", "mean"),
        )
        .reset_index()
        .sort_values("active_listings", ascending=False)
    )

    cohorts["popularity_rank"] = range(1, len(cohorts) + 1)
    cohorts["sold_last_7d"] = 0

    result = cohorts.to_dict("records")
    logger.info(f"Popularity snapshot saved: {len(result)} cohorts")
    return result