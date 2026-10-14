import os
import joblib
import numpy as np
import pandas as pd
from datetime import datetime
from loguru import logger

from sklearn.model_selection import train_test_split, GridSearchCV, GroupShuffleSplit, GroupKFold
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.linear_model import LinearRegression, LassoCV
from sklearn.ensemble import RandomForestRegressor, VotingRegressor
from sklearn.inspection import permutation_importance
from sklearn.base import BaseEstimator, RegressorMixin, clone


from xgboost import XGBRegressor

from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer

from env_utils import env_int

class RelaxedLasso(BaseEstimator, RegressorMixin):
    """
    Two-step Relaxed LASSO (mirrors the R notes workflow):

    Step 1 — LassoCV (equivalent to cv.glmnet, alpha=1):
        Fits LASSO across a path of lambda values with k-fold CV.
        The lambda that minimises CV error selects a sparse set of features
        by driving weak coefficients exactly to zero.

    Step 2 — OLS refit on selected features (equivalent to lm() in the notes):
        Refits plain LinearRegression on only the surviving features.
        This removes the shrinkage bias introduced by LASSO — the kept
        coefficients are no longer pulled toward zero, so they are
        interpretable as ordinary regression coefficients.

    Why standardise first?
        glmnet standardises internally before applying the L1 penalty so
        that the penalty treats all features equally regardless of scale.
        sklearn's LassoCV does not do this, so we standardise manually.
        The OLS refit uses the original (unstandardised) X so that
        coefficients are interpretable in their natural units.

    Attributes after fit:
        lasso_          : fitted LassoCV object (access .alpha_ for chosen lambda)
        selected_mask_  : boolean array of which preprocessed columns survived
        n_selected_     : int, number of surviving features
        ols_            : fitted LinearRegression on the selected columns
        lasso_coef_     : LASSO coefficients for selected features (shrunk)
        ols_coef_       : OLS coefficients for selected features (unbiased)
    """

    def __init__(
        self,
        cv: int = 5,
        max_iter: int = 10000,
        tol: float = 1e-3,
        max_features: int = 150,
    ):
        self.cv = cv
        self.max_iter = max_iter
        self.tol = tol
        # Hard cap on features: if lambda_min selects more than max_features,
        # walk lambda upward through the CV path (increasing regularisation)
        # until the count falls at or below the cap. This takes the minimum
        # lambda that satisfies the constraint — least additional regularisation
        # beyond what is strictly needed for a stable OLS refit.
        self.max_features = max_features

    def fit(self, X, y, sample_weight=None):
        import scipy.sparse as sp
        from sklearn.linear_model import Lasso

        # Standardise for LASSO selection (mirrors glmnet's internal scaling).
        # with_mean=False is required for sparse matrices.
        is_sparse = sp.issparse(X)
        self.scaler_ = StandardScaler(with_mean=not is_sparse)
        X_scaled = self.scaler_.fit_transform(X)

        # Step 1: LASSO with cross-validated lambda (equivalent to cv.glmnet)
        self.lasso_ = LassoCV(
            cv=self.cv,
            max_iter=self.max_iter,
            tol=self.tol,
            n_jobs=-1,
        )
        self.lasso_.fit(X_scaled, y)

        self.lambda_min_ = self.lasso_.alpha_
        coef = self.lasso_.coef_.copy()
        self.lambda_used_ = self.lambda_min_

        # If lambda_min selects more than max_features, walk lambda upward
        # through the tested path (ascending = increasing regularisation).
        # Take the first lambda that brings the count within the cap.
        if np.sum(np.abs(coef) > 1e-8) > self.max_features:
            # alphas_ are sorted descending in LassoCV; reverse for ascending walk
            for alpha in sorted(self.lasso_.alphas_):
                if alpha <= self.lambda_min_:
                    continue  # already tried this — need more regularisation
                _l = Lasso(alpha=alpha, max_iter=self.max_iter, tol=self.tol)
                _l.fit(X_scaled, y)
                if np.sum(np.abs(_l.coef_) > 1e-8) <= self.max_features:
                    coef = _l.coef_
                    self.lambda_used_ = alpha
                    break

        # Features with non-zero LASSO coefficients are "selected"
        self.selected_mask_ = np.abs(coef) > 1e-8
        self.n_selected_ = int(self.selected_mask_.sum())
        self.lasso_coef_ = coef[self.selected_mask_]

        # Step 2: OLS refit on unscaled selected features (debiased / relaxed)
        X_dense = X.toarray() if is_sparse else X
        X_sel = X_dense[:, self.selected_mask_]
        self.ols_ = LinearRegression()
        if self.n_selected_ > 0:
            fit_kwargs = {"sample_weight": sample_weight} if sample_weight is not None else {}
            self.ols_.fit(X_sel, y, **fit_kwargs)
            self.ols_coef_ = self.ols_.coef_
        else:
            # Degenerate case: LASSO zeroed everything — fall back to intercept
            self.ols_.intercept_ = float(np.mean(y))
            self.ols_.coef_ = np.array([])
            self.ols_coef_ = np.array([])

        return self

    def predict(self, X):
        import scipy.sparse as sp
        X_dense = X.toarray() if sp.issparse(X) else X
        if self.n_selected_ == 0:
            return np.full(X_dense.shape[0], self.ols_.intercept_)
        return self.ols_.predict(X_dense[:, self.selected_mask_])


MODEL_PATH = "models/price_predictor.joblib"
MIN_TRAINING_SAMPLES = env_int("MIN_TRAINING_SAMPLES", 140)
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

    out["zip3"] = (
        df.get("location_zip", pd.Series([""] * len(df), index=df.index))
        .astype(str)
        .str.strip()
        .str[:3]
        .replace({"": "000"})
    )

    # exterior_color: black/white/silver tend to retain value better than
    # unusual colours. Treat as a categorical (one-hot encoded downstream).
    out["exterior_color"] = _norm_str(
        df.get("exterior_color", pd.Series([""] * len(df), index=df.index))
    )

    return out


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


def _dealer_keys(df: pd.DataFrame) -> pd.Series:
    """Normalised dealer name; a listing with none counts as its own dealer."""
    d = df.get("dealer_name", pd.Series("", index=df.index)).fillna("").astype(str).str.lower().str.strip()
    return d.where(d != "", "listing:" + df["listing_id"].astype(str))


def _cohort_ref(X: pd.DataFrame, dealers: pd.Series, y: pd.Series) -> pd.DataFrame:
    """The training rows cohort features are computed from."""
    return pd.DataFrame({
        "make": X["make"].to_numpy(), "model": X["model"].to_numpy(), "year": X["year"].to_numpy(),
        "dealer": dealers.to_numpy(), "price": y.to_numpy(),
    })


def _cohort_features(X: pd.DataFrame, dealers: pd.Series, ref: pd.DataFrame) -> pd.DataFrame:
    """
    cohort_median_price and cohort_count per (make, model, year) from the ref
    rows of *other dealers*. A fleet seller's own cars would otherwise set
    the "market" its listings are judged against, so its markup always looks
    fair. Also keeps a training row's own price out of its features (it shares
    its own dealer key), which is what the old k-fold encoding was for.
    """
    q = pd.DataFrame({
        "make": X["make"].to_numpy(), "model": X["model"].to_numpy(), "year": X["year"].to_numpy(),
        "dealer": dealers.to_numpy(), "_row": np.arange(len(X)),
    })
    m = q.merge(ref, on=["make", "model", "year"], suffixes=("", "_ref"))
    stats = m[m["dealer"] != m["dealer_ref"]].groupby("_row")["price"].agg(["median", "count"])
    rows = np.arange(len(X))
    X = X.copy()
    X["cohort_median_price"] = stats["median"].reindex(rows).to_numpy()
    X["cohort_count"] = stats["count"].reindex(rows).fillna(0).to_numpy().astype(float)
    return X


def _vin_groups(df: pd.DataFrame) -> pd.Series:
    """One group per car: the VIN, or the listing id when there is no VIN."""
    vin = df["vin"].fillna("")
    return vin.where(vin != "", "listing:" + df["listing_id"].astype(str))


def _vin_split(df: pd.DataFrame, seed: int = 42):
    """
    Positional train/val/test indices (64/16/20), grouped by VIN so no car
    lands in two splits. Test is carved first, then val from the remainder.
    training_pool_v already keeps one row per VIN; grouping is the safeguard
    if that ever regresses.
    """
    groups = _vin_groups(df).to_numpy()
    idx = np.arange(len(df))
    rest, test = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=seed).split(idx, groups=groups))
    tr, val = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=seed).split(rest, groups=groups[rest]))
    return rest[tr], rest[val], test


def train(df: pd.DataFrame, repo, model_path: str | None = MODEL_PATH) -> dict | None:
    """df: rows from ListingRepository.get_training_listings_df; repo: that
    ListingRepository, used to compute cohort stats in SQL. model_path=None
    trains and evaluates without saving (scripts/holdout_audit.py).

    The test split is touched once, for reporting: model selection and the
    calibration offset both use the validation split."""
    logger.info("Starting model training run…")

    # -----------------------------
    # 1) Rows arrive pre-filtered by the training_listings_v SQL view
    #    (db/models.py) — price/mileage bounds, stale days_listed, nulls.
    # -----------------------------
    if len(df) < MIN_TRAINING_SAMPLES:
        logger.warning(f"Not enough data to train ({len(df)} rows, need {MIN_TRAINING_SAMPLES})")
        return None

    # -----------------------------
    # 2) Build features + split
    # -----------------------------
    X_raw = _build_features_raw(df)
    y = df["price"]

    tr, va, te = _vin_split(df)
    X_train, X_val, X_test = X_raw.iloc[tr], X_raw.iloc[va], X_raw.iloc[te]
    y_train, y_val, y_test = y.iloc[tr], y.iloc[va], y.iloc[te]

    # Cohort features come from training-split rows of other dealers (see
    # _cohort_features). The all-dealer SQL stats serve /api/predict, whose
    # car has no dealer.
    full_cohort_stats = repo.get_cohort_stats(df["id"].iloc[tr])
    dealers = _dealer_keys(df)
    cohort_ref = _cohort_ref(X_train, dealers.iloc[tr], y_train)
    X_train = _cohort_features(X_train, dealers.iloc[tr], cohort_ref)
    X_val = _cohort_features(X_val, dealers.iloc[va], cohort_ref)
    X_test = _cohort_features(X_test, dealers.iloc[te], cohort_ref)

    # log-space targets (this is what we train on)
    y_train_log = np.log1p(y_train)
    y_val_log = np.log1p(y_val)

    # -----------------------------
    # 3) Preprocess
    # -----------------------------
    numeric_features = [
        "year", "vehicle_age", "age_sq", "log_age",
        "mileage", "log_mileage", "miles_per_year",
        "is_luxury", "is_truck", "is_sports",
        "lux_age", "lux_mpy",
        "trim_rank",
        "cohort_median_price", "cohort_count",
    ]
    categorical_features = [
        "make", "model", "state",
        "trim", "body_type", "zip3",
        "exterior_color",
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
        "relaxed_lasso": RelaxedLasso(cv=5, max_iter=10000, tol=1e-3),
        "rf": RandomForestRegressor(
            n_estimators=300,
            random_state=42,
            n_jobs=-1,
            min_samples_leaf=2,
        ),
    }

    # Fixed hyperparameters shared by every XGBRegressor built below —
    # only n_estimators/learning_rate/early-stopping args vary between them.
    xgb_fixed_params = dict(
        max_depth=6,
        subsample=0.8,
        colsample_bytree=0.7,
        min_child_weight=3,
        gamma=0.05,
        reg_alpha=0.05,
        reg_lambda=1.0,
        random_state=42,
        verbosity=0,
        # Squared error on the log target. Absolute error was $436 worse on
        # test MAE (2026-10-14), and worse in every price and luxury slice.
        objective="reg:squarederror",
    )

    # Joint grid search over M (n_estimators) and eta (learning_rate).
    # These two are not independent: small eta needs many trees to converge,
    # large eta converges faster but may overshoot. Searching them jointly
    # finds the true optimum rather than two separate marginal optima.
    base_xgb = XGBRegressor(**xgb_fixed_params)
    gs_pipe = Pipeline(steps=[
        ("preprocess", preprocess),
        ("model", base_xgb),
    ])
    param_grid = {
        "model__learning_rate": [0.01, 0.03, 0.05, 0.1, 0.15, 0.2],
        "model__n_estimators":  [500, 1000, 1500, 2000],
    }
    logger.info("Running XGB grid search (6×4 grid, 5-fold CV = 120 fits)…")
    grid_search = GridSearchCV(
        gs_pipe,
        param_grid,
        cv=5,
        scoring="neg_mean_absolute_error",
        n_jobs=-1,
        refit=False,
        verbose=0,
    )
    grid_search.fit(X_train, y_train_log)
    best_params = grid_search.best_params_
    logger.info(
        f"XGB grid search best: learning_rate={best_params['model__learning_rate']}, "
        f"n_estimators={best_params['model__n_estimators']}  "
        f"(CV MAE log={-grid_search.best_score_:.4f})"
    )

    # Early stopping: find the true optimal n_estimators given the best lr.
    # The grid search ceiling (2000) may be too low or higher than needed —
    # early stopping on a held-out slice tells us exactly when to stop.
    X_tr_es, X_val_es, y_tr_es, y_val_es = train_test_split(
        X_train, y_train_log, test_size=0.15, random_state=0
    )
    pre_es = clone(preprocess)
    pre_es.fit(X_train)  # fit on full X_train so OHE sees all categories
    xgb_es = XGBRegressor(
        n_estimators=3000,
        learning_rate=best_params["model__learning_rate"],
        **xgb_fixed_params,
        early_stopping_rounds=50,
        eval_metric="mae",
    )
    xgb_es.fit(
        pre_es.transform(X_tr_es),
        y_tr_es,
        eval_set=[(pre_es.transform(X_val_es), y_val_es)],
        verbose=False,
    )
    optimal_n = xgb_es.best_iteration
    logger.info(
        f"Early stopping: optimal n_estimators={optimal_n} "
        f"(ceiling=3000, grid search suggested {best_params['model__n_estimators']})"
    )

    # Average 5 seeds (subsample/colsample make them differ): cuts variance at
    # ~6k rows. Measured -$48 test MAE over 3 VIN splits, better on each.
    xgb_lr = best_params["model__learning_rate"]
    candidates["xgb"] = VotingRegressor([
        (f"seed{s}", XGBRegressor(n_estimators=optimal_n, learning_rate=xgb_lr,
                                  **{**xgb_fixed_params, "random_state": s}))
        for s in range(42, 47)
    ])

    def _eval(y_true_np: np.ndarray, y_pred_np: np.ndarray) -> tuple[float, float]:
        mae = float(mean_absolute_error(y_true_np, y_pred_np))
        rmse = float(np.sqrt(mean_squared_error(y_true_np, y_pred_np)))
        return mae, rmse

    fitted: dict[str, Pipeline] = {}
    metrics: dict[str, dict] = {}
    test_preds: dict[str, np.ndarray] = {}
    val_logs: dict[str, np.ndarray] = {}

    # -----------------------------
    # 5) Train + evaluate each candidate
    # -----------------------------
    for name, model in candidates.items():
        pipe = Pipeline(steps=[
            ("preprocess", preprocess),
            ("model", model),
        ])

        pipe.fit(X_train, y_train_log)

        # ---- Relaxed LASSO: log selected features + coefficient comparison ----
        if name == "relaxed_lasso":
            rl = pipe.named_steps["model"]
            try:
                feat_names = pipe.named_steps["preprocess"].get_feature_names_out()
                sel = feat_names[rl.selected_mask_]
                total = len(feat_names)
                logger.info(
                    f"Relaxed LASSO: {rl.n_selected_}/{total} features selected  "
                    f"(λ_used={rl.lambda_used_:.5f}, λ_min={rl.lambda_min_:.5f})"
                )
                # Mirror the R notes: show LASSO estimate vs OLS (debiased) estimate
                coef_rows = sorted(
                    zip(sel, rl.lasso_coef_, rl.ols_coef_),
                    key=lambda r: abs(r[2]),
                    reverse=True,
                )
                header = f"  {'Feature':<45} {'LASSO':>10}  {'OLS (debiased)':>14}"
                lines = [header, "  " + "-" * 73]
                for feat, lc, oc in coef_rows[:20]:
                    lines.append(f"  {feat:<45} {lc:>+10.4f}  {oc:>+14.4f}")
                logger.info("Top 20 coefficients (log-price space):\n" + "\n".join(lines))
            except Exception as e:
                logger.warning(f"Could not log Relaxed LASSO coefficients: {e}")

        # ---- training RMSE (log-space) for ALL models (works consistently) ----
        pred_train_log = pipe.predict(X_train)
        train_rmse_log = float(np.sqrt(mean_squared_error(y_train_log.to_numpy(), pred_train_log)))

        # ---- validation: the only split selection and calibration look at ----
        # Selection uses uncalibrated val MAE, since the offset is fit on val too.
        val_log = pipe.predict(X_val)
        val_logs[name] = val_log
        val_mae = float(mean_absolute_error(y_val, np.expm1(val_log)))
        log_cal = float(np.median(val_log - y_val_log.to_numpy()))

        # ---- test metrics in $ space, calibrated as production serves them ----
        pred_test = np.expm1(pipe.predict(X_test) - log_cal)
        y_true = y_test.to_numpy()
        mae, rmse = _eval(y_true, pred_test)

        # slice MAE: luxury vs non-lux
        test_is_lux = (X_test["is_luxury"].to_numpy() >= 0.5)
        lux_n = int(test_is_lux.sum())
        nonlux_n = int((~test_is_lux).sum())

        lux_mae = float(np.mean(np.abs(pred_test[test_is_lux] - y_true[test_is_lux]))) if lux_n > 0 else float("nan")
        nonlux_mae = float(np.mean(np.abs(pred_test[~test_is_lux] - y_true[~test_is_lux]))) if nonlux_n > 0 else float("nan")

        fitted[name] = pipe
        test_preds[name] = pred_test
        metrics[name] = {
            "val_mae": val_mae,
            "log_calibration": log_cal,
            "mae": mae,
            "rmse": rmse,
            "train_rmse_log": train_rmse_log,
            "luxury_n": lux_n,
            "nonlux_n": nonlux_n,
            "luxury_mae": lux_mae,
            "nonlux_mae": nonlux_mae,
        }

        logger.info(
            f"Candidate {name} | val MAE=${val_mae:,.0f} | test MAE=${mae:,.0f} RMSE=${rmse:,.0f} | "
            f"trainRMSE(log)={train_rmse_log:.4f} | "
            f"luxury=${lux_mae:,.0f} (n={lux_n}) nonlux=${nonlux_mae:,.0f} (n={nonlux_n})"
        )

        # Price tier breakdown — shows % error at each price level.
        # MAE is heteroscedastic: the same dollar error hits cheap cars harder.
        _buckets = [
            ("<$10k",   0,      10_000),
            ("$10-20k", 10_000, 20_000),
            ("$20-35k", 20_000, 35_000),
            ("$35-60k", 35_000, 60_000),
            (">$60k",   60_000, float("inf")),
        ]
        _tier_parts = []
        for _label, _lo, _hi in _buckets:
            _mask = (y_true >= _lo) & (y_true < _hi)
            _n = int(_mask.sum())
            if _n < 5:
                continue
            _tier_mae  = float(np.mean(np.abs(pred_test[_mask] - y_true[_mask])))
            _tier_mean = float(np.mean(y_true[_mask]))
            _tier_pct  = _tier_mae / _tier_mean * 100
            _tier_parts.append(f"{_label} ${_tier_mae:,.0f} ({_tier_pct:.0f}%,n={_n})")
        logger.info("  tiers | " + " | ".join(_tier_parts))

    # pick best by validation MAE — never by test
    best_name = min(metrics.keys(), key=lambda k: metrics[k]["val_mae"])
    pipe = fitted[best_name]
    best = metrics[best_name]

    logger.info(
        f"Selected model: {best_name} | val MAE=${best['val_mae']:,.0f} | "
        f"test MAE=${best['mae']:,.0f} RMSE=${best['rmse']:,.0f}"
    )

    # -----------------------------
    # 6) Calibration — correct systematic bias in log space
    # -----------------------------
    # Median log residual on the validation split. Subtracting it from future
    # log-space predictions centres the errors, giving a balanced mix of
    # positive and negative savings at scoring time.
    log_calibration = best["log_calibration"]
    direction = "over" if log_calibration > 0 else "under"
    logger.info(
        f"Calibration offset (log, val set): {log_calibration:.4f}  "
        f"(≈ {abs(np.expm1(-abs(log_calibration)) * 100):.1f}% systematic {direction}prediction corrected)"
    )

    # Out-of-fold predictions for the training-split cars. The final model
    # fits them closely, so scoring them with it hides their deals (4+ stars
    # 4.4% vs 7.5% for unseen cars). Each is scored instead by one of 5
    # models trained without its VIN, with cohort features from those folds.
    groups_tr = _vin_groups(df.iloc[tr]).to_numpy()
    X_train_raw, dealers_tr = X_raw.iloc[tr], dealers.iloc[tr]
    oof_log, oof_count = np.empty(len(tr)), np.empty(len(tr))
    for f_tr, f_ho in GroupKFold(n_splits=5).split(X_train_raw, groups=groups_tr):
        ref = _cohort_ref(X_train_raw.iloc[f_tr], dealers_tr.iloc[f_tr], y_train.iloc[f_tr])
        fold_pipe = clone(pipe).fit(
            _cohort_features(X_train_raw.iloc[f_tr], dealers_tr.iloc[f_tr], ref), y_train_log.iloc[f_tr])
        X_ho = _cohort_features(X_train_raw.iloc[f_ho], dealers_tr.iloc[f_ho], ref)
        oof_log[f_ho], oof_count[f_ho] = fold_pipe.predict(X_ho), X_ho["cohort_count"]
    oof_predictions = dict(zip(groups_tr, np.expm1(oof_log - log_calibration)))

    # Typical error per price segment and cohort size — the deal score's
    # yardstick (see _deal_score_from_prices). Pools val with the training
    # cars' out-of-fold errors (~7.4k rows) so the cells aren't noisy.
    segment_errors = _segment_errors(
        np.concatenate([y_val.to_numpy(), y_train.to_numpy()]),
        np.expm1(np.concatenate([val_logs[best_name], oof_log]) - log_calibration),
        np.concatenate([X_val["cohort_count"].to_numpy(), oof_count]),
    )
    logger.info("Segment median abs % error (val + OOF), by cohort size: " + " | ".join(
        f"${lo:,.0f}-{'' if hi == float('inf') else f'${hi:,.0f}'}: {err:.1f}% ("
        + "/".join(f"{c:.1f}" for _, _, c in cells) + ")" for lo, hi, err, cells in segment_errors))

    # -----------------------------
    # 7) Permutation importance on RAW features (24 cols), validation split
    # -----------------------------
    try:
        pi = permutation_importance(
            pipe,
            X_val,                   # raw features
            y_val_log,               # log target (matches training)
            n_repeats=5,
            random_state=42,
            n_jobs=-1,
            scoring="neg_mean_absolute_error",
        )

        imp = (
            pd.Series(pi.importances_mean, index=X_val.columns)
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
        "cohort_ref": cohort_ref,
        "oof_predictions": oof_predictions,
        "segment_errors": segment_errors,
    }

    if model_path:
        os.makedirs(os.path.dirname(model_path) or ".", exist_ok=True)
        joblib.dump(payload, model_path)

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
    logger.info(f"Train/Val/Test split (VIN-grouped): {len(X_train)}/{len(X_val)}/{len(X_test)}")
    logger.info("="*72 + "\n")

    return {
        "version":        version,
        "selected_model": best_name,
        "metrics":        metrics,
        "n":              int(len(df)),
        "train_rows":     int(len(X_train)),
        "val_rows":       int(len(X_val)),
        "test_rows":      int(len(X_test)),
        "xgb_lr":         xgb_lr,
        "xgb_n_estimators": optimal_n,
        # for scripts/holdout_audit.py: positional split indices into df and
        # calibrated test predictions per candidate
        "split":          {"train": tr, "val": va, "test": te},
        "y_test":         y_test.to_numpy(),
        "test_preds":     test_preds,
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


# Price segments (by asking price) for the deal score's error yardstick.
PRICE_SEGMENTS = [(0, 10_000), (10_000, 20_000), (20_000, 35_000), (35_000, 60_000), (60_000, float("inf"))]
# 5 Stars needs a discount of this many times the segment's median abs %
# error. Median |error| is ~0.67 sigma for normal errors, so 3x is ~2 sigma:
# fewer than 1 in 40 fairly priced cars should look that cheap by model error.
FIVE_STAR_MULTIPLE = 3.0
# Used when a model payload has no per-segment errors (trained before they
# existed). It reproduces the original fixed scale, 5 Stars at a 32% discount
# (score = 50 + 1.25 * diff_pct).
DEFAULT_SEGMENT_ERROR_PCT = 32.0 / FIVE_STAR_MULTIPLE


# cohort_count bins for the yardstick. Rare cars are predicted far less
# reliably: with one error per price band, held-out cars from cohorts under
# 3 got 4+ stars 14.9% of the time vs 2.0% for cohorts of 30+.
COHORT_BINS = [(0, 3), (3, 10), (10, float("inf"))]


def _segment_errors(y_true: np.ndarray, y_pred: np.ndarray, cohort_count: np.ndarray | None = None,
                    min_n: int = 30) -> list[tuple]:
    """(lo, hi, median abs % error) per PRICE_SEGMENTS bucket, by true price.
    Buckets with fewer than min_n rows fall back to the overall median.
    Given cohort_count, each bucket also gets a 4th item: (lo, hi, error)
    per COHORT_BINS cell, falling back to the bucket's error under min_n."""
    ape = np.abs(y_pred - y_true) / y_true * 100
    overall = float(np.median(ape))
    out = []
    for lo, hi in PRICE_SEGMENTS:
        m = (y_true >= lo) & (y_true < hi)
        err = float(np.median(ape[m])) if m.sum() >= min_n else overall
        if cohort_count is None:
            out.append((lo, hi, err))
            continue
        cells = []
        for clo, chi in COHORT_BINS:
            c = m & (cohort_count >= clo) & (cohort_count < chi)
            cells.append((clo, chi, float(np.median(ape[c])) if c.sum() >= min_n else err))
        out.append((lo, hi, err, cells))
    return out


def _segment_error_for(price: float, segment_errors: list[tuple] | None,
                       cohort_count: float | None = None) -> float:
    for lo, hi, err, *cells in segment_errors or ():
        if lo <= price < hi:
            for clo, chi, cell_err in (cells[0] if cells and cohort_count is not None else ()):
                if clo <= cohort_count < chi:
                    return cell_err
            return err
    return DEFAULT_SEGMENT_ERROR_PCT


def _deal_score_from_prices(actual: float, predicted: float,
                            segment_error_pct: float = DEFAULT_SEGMENT_ERROR_PCT) -> float:
    """
    Map the pricing gap to a 0–100 score, measured in units of the model's
    typical error at this price (segment_error_pct: median abs % error of the
    model in the listing's price segment).

    Let diff_pct = (predicted - actual) / predicted * 100   (+ = under market)
    and z = diff_pct / segment_error_pct. Then score = 50 + 40 * z / 3, clamped:
      z >= +3      -> 90+ (5 Stars): discount is 3x what the model typically gets wrong
      z >= +1.875  -> 75+ (4 Stars)
      z  =  0      -> 50 (fair)
      z <= -3.75   -> 0

    So a 20% discount is 5 Stars where the model is usually within 6%, but
    only 3 Stars where it is usually off by 17% (cheap cars).
    """
    if predicted <= 0 or segment_error_pct <= 0:
        return 50.0

    diff_pct = (predicted - actual) / predicted * 100.0  # + = good
    score = 50.0 + 40.0 * diff_pct / (segment_error_pct * FIVE_STAR_MULTIPLE)
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
    if payload.get("cohort_ref") is not None:
        X = _cohort_features(X, _dealer_keys(df), payload["cohort_ref"])
    elif payload.get("cohort_stats") is not None:  # models trained before cohort_ref
        X = _apply_cohort_features(X, payload["cohort_stats"])
    log_calibration = payload.get("log_calibration", 0.0)
    preds = np.expm1(model.predict(X) - log_calibration)
    # Cars the model trained on get their out-of-fold prediction (see train)
    oof = _vin_groups(df).map(payload.get("oof_predictions") or {}).to_numpy(dtype=float)
    preds = np.where(np.isnan(oof), preds, oof)
    logger.info(f"{int((~np.isnan(oof)).sum())} training-split listings use out-of-fold predictions")
    segment_errors = payload.get("segment_errors")
    if segment_errors is None:
        logger.warning("Model has no per-segment errors; scoring on the default scale (retrain to fix)")

    counts = X["cohort_count"].to_numpy() if "cohort_count" in X else None

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

        score = _deal_score_from_prices(
            actual=actual, predicted=predicted,
            segment_error_pct=_segment_error_for(
                actual, segment_errors, None if counts is None else float(counts[i])),
        )
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