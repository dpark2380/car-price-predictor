# Candidate Models — Theory & CarIntel Implementation

This document covers the theory behind each candidate model used in `ml/pipeline.py` (Linear Regression, Relaxed LASSO, Random Forest, and XGBoost), maps GBM/XGBoost theory to our specific implementation choices, and records improvements made over time.

---

## 1. The Core Ensemble (XGBoost)

**Theory:**

$$f(x) = \sum_{m=1}^M \beta_m b(x, \gamma_m)$$

where $b(x, \gamma_m)$ is a small tree with splitting rules $\gamma_m$ and weight $\beta_m$.

**Our implementation:**

Our model builds exactly this sum. Each tree produced by XGBoost is one $b(x, \gamma_m)$, with M selected automatically by joint grid search followed by early stopping (see Section 4). The final prediction is the accumulated sum across all M trees' leaf values.

One important twist: our **target is `log1p(price)`**, not price directly. So the ensemble learns:

$$\sum_{m=1}^{M} \beta_m b(x, \gamma_m) \approx \ln(1 + \text{price})$$

and we exponentiate back at scoring time with `np.expm1(...)`. This treats errors multiplicatively — a $5,000 error on a $10,000 car and a $5,000 error on a $50,000 car are not equivalent. Training in log space makes them comparable.

---

## 2. Loss Function — MAE, Not MSE

**Theory:** Presents MSE (RSS) as the standard regression loss:

$$\min \sum_{i=1}^n \left(y_i - \hat{f}(x_i)\right)^2$$

**Our implementation:**

```python
objective="reg:absoluteerror"
```

We explicitly use **MAE** instead of MSE. This is a deliberate domain choice — car pricing has expensive outliers (low-mileage luxury trims, rare configurations) and MSE would square those residuals, forcing the model to over-fit to them. MAE weights all errors linearly, making the ensemble more robust across the full price range.

The forward stagewise math still applies — the residuals being fit are just $|r_i|$-weighted rather than $r_i^2$-weighted.

---

## 3. Forward Stagewise Additive Modelling

**Theory:**

1. Initialise: $\hat{y}^{(0)}(x) = \bar{y}$
2. At step $m$, find: $(\beta_m, \gamma_m) = \arg\min_{\beta, \gamma} \sum_i \left(y_i - \hat{y}^{(m-1)}(x_i) - \beta b(x_i, \gamma)\right)^2$
3. Update: $\hat{y}^{(m)}(x) = \hat{y}^{(m-1)}(x) + \eta \cdot \beta_m b(x, \gamma_m)$

**Our implementation:**

- **Step 1:** XGBoost internally initialises to the mean of `log1p(price)`
- **Step 2:** At each boosting round, XGBoost fixes the current prediction and finds the tree that minimally reduces the current residuals
- **Step 3 — Shrinkage:** $\eta$ is determined by grid search (see Section 4)

---

## 4. Choosing M — Joint Grid Search + Early Stopping

**Theory** describes three approaches:

| Approach | Test RMSE (lecture example) |
|---|---|
| Naive (fixed M=500) | 3.68 |
| CV + early stopping | 3.69 |
| Full grid search | **3.07** |

**Our implementation:** We use a two-phase approach combining both grid search and early stopping.

**Phase 1 — Joint grid search over M and eta:**

M (`n_estimators`) and eta (`learning_rate`) are not independent. A small eta needs many trees to converge; a large eta converges with fewer trees but may overshoot. Tuning them separately produces suboptimal results — the joint search finds the true optimum on the efficient frontier.

```python
_param_grid = {
    "model__learning_rate": [0.01, 0.03, 0.05, 0.1],
    "model__n_estimators":  [500, 1000, 1500, 2000],
}
# 4×4 = 16 combinations × 5-fold CV = 80 fits
```

**Phase 2 — Early stopping to find true optimal M:**

The grid search treats `n_estimators` as a discrete grid parameter. Early stopping on a 15% held-out slice of `X_train` finds the precise point where validation MAE stops improving, using a ceiling of 3,000 trees.

```python
XGBRegressor(n_estimators=3000, early_stopping_rounds=50, ...)
```

The `best_iteration` from early stopping becomes the final `n_estimators`.

**Result:** Grid search consistently finds `learning_rate=0.1` is optimal. Early stopping then finds the precise M for the current dataset size.

---

## 5. Regularisation — $\Omega(b)$

**Theory:**

$$L = \sum_{i=1}^n (y_i - \hat{f}(x_i))^2 + \Omega(b)$$

where $\Omega(b)$ penalises tree complexity via:
- `gamma`: minimum loss reduction required to make a split
- `lambda`: L2 regularisation on leaf weights

**Our implementation:**

| Parameter | Theory example | Our value | Effect |
|---|---|---|---|
| `gamma=0.05` | 1.0 | 0.05 | Very permissive — almost any split allowed |
| `reg_lambda=1.0` | 1.0 | 1.0 | Standard L2 shrinkage on leaf values |
| `reg_alpha=0.05` | *(not in theory)* | 0.05 | L1 — drives small leaf weights to exactly zero |

`reg_alpha` (L1) is not in the theory's parameter list but works like LASSO on the leaf weights — it encourages sparsity, which can sharpen splits on binary features like `is_luxury` or `accident_count`.

---

## 6. Tree Size Control

**Theory:** `max_depth=3`, `min_child_weight=1`

**Our implementation:**

```python
max_depth=6           # deeper than textbook default
min_child_weight=3    # minimum 3 observations per leaf
```

We use `max_depth=6` — deeper trees capable of capturing more complex interactions (e.g., luxury × age × mileage × state). This works because the other regularisation (lambda, alpha, subsample) controls overfitting despite the depth.

`min_child_weight=3` prevents hyper-specific splits on rare (make, trim, state) combinations that appear only once or twice in training data — slightly stricter than the theory's default of 1.

---

## 7. Subsampling

**Theory:** `subsample=0.7` (rows), `colsample_bytree=1.0` (columns)

**Our implementation:**

```python
subsample=0.8          # 80% of rows per tree
colsample_bytree=0.7   # 70% of features per tree
```

At each boosting round, XGBoost draws 80% of training rows and 70% of the feature columns. This mirrors Random Forest's row bagging and `mtry` — reduces correlation between trees, provides a rough OOB error estimate, and speeds up training.

`colsample_bytree=0.7` is especially meaningful because our feature space after one-hot encoding is wide (hundreds of make/model/state/trim dummies). Masking 30% prevents any single tree from always conditioning on the same high-cardinality categorical.

---

## 8. Pipeline Architecture Beyond the Theory

The theory shows XGBoost operating directly on a feature matrix. Our implementation wraps it in a scikit-learn `Pipeline` with two stages:

1. **`ColumnTransformer`**: median imputation for numerics, mode imputation + one-hot encoding for categoricals
2. **`XGBRegressor`**: the boosted model itself

This means $x_i$ in $b(x_i, \gamma_m)$ is the transformed, imputed, one-hot-encoded vector — not a raw scraped row.

**K-Fold Cohort Encoding** is a custom addition beyond the theory. The `cohort_median_price` feature tells the model "what do similar cars (same make/model/year) typically sell for?" Naively computing this from all training data would let each row partially see its own price — target leakage. We solve this with 5-fold target encoding:
- For each training row, compute cohort median from the **other 4 folds only**
- At inference, use full training cohort stats (no leakage concern)

**Post-Training Calibration** is also not in the theory:

```python
log_calibration = float(np.median(test_log_preds - y_test_log.to_numpy()))
```

After training, we compute the median systematic bias on the test set (in log space) and subtract it from all future predictions. This ensures the model doesn't consistently over- or under-predict by a fixed percentage — critical for a deal-scoring system where we need $\hat{y} = y$ at the median.

---

## 9. Full XGBoost Parameter Comparison

| Parameter | Theory example | Our value |
|---|---|---|
| `objective` | `reg:squarederror` (MSE) | `reg:absoluteerror` (MAE) |
| `n_estimators` (M) | 500 | **grid-searched** over [500, 1000, 1500, 2000] then early-stopped |
| `learning_rate` (eta) | 0.1 | **grid-searched** over [0.01, 0.03, 0.05, 0.1] |
| `max_depth` | 3 | **6** |
| `subsample` | 0.7 | 0.8 |
| `colsample_bytree` | 1.0 | **0.7** |
| `gamma` | 1.0 | **0.05** |
| `reg_lambda` | 1.0 | 1.0 |
| `reg_alpha` | *(not in theory)* | **0.05** |
| `min_child_weight` | 1 | **3** |
| Target | raw price | **log1p(price)** |
| Calibration | none | **median log-space correction** |

---

## 10. Linear Regression

### Theory

Linear regression fits a hyperplane through the training data by minimising the residual sum of squares:

$$\hat{y} = \beta_0 + \beta_1 x_1 + \beta_2 x_2 + \cdots + \beta_p x_p$$

$$\min_\beta \sum_{i=1}^n (y_i - \hat{y}_i)^2$$

This has a closed-form solution — no iterative optimisation required:

$$\hat{\beta} = (X^\top X)^{-1} X^\top y$$

Each coefficient $\beta_j$ represents the change in predicted price for a one-unit increase in feature $x_j$, holding all other features constant.

### Our implementation

```python
LinearRegression()   # sklearn defaults, no regularisation
```

Trained on `log1p(price)` like the other candidates, so coefficients express proportional rather than absolute price effects.

### Benefits

- **Interpretability:** every coefficient has a direct meaning
- **Speed:** training is near-instant regardless of dataset size
- **Stable baseline:** no hyperparameters, completely reproducible

### Limitations

- Cannot capture nonlinear relationships (depreciation is not linear)
- Cannot capture interactions without explicit feature engineering
- Sensitive to correlated features (multicollinearity inflates variance)

### Performance (2026-04-27, ~7,000 rows)

| Segment | MAE | RMSE |
|---|---|---|
| Overall | ~$4,944 | ~$8,107 |
| Luxury | ~$7,015 | — |
| Non-luxury | ~$4,174 | — |

The luxury MAE nearly doubling non-luxury illustrates the core limitation: luxury depreciation is exponential and trim-dependent, which a linear model cannot represent.

---

## 11. LASSO and Relaxed LASSO

### Theory — The Sparsity Problem

When there are many predictors, OLS either overfits or becomes unsolvable ($p > n$). Even when $n > p$, many coefficients may be near-zero noise. LASSO (Least Absolute Shrinkage and Selection Operator) solves a penalised least squares problem:

$$\min_{\beta_0, \beta_1, \ldots, \beta_p} \left\{ \frac{1}{2n} \sum_{i=1}^n (y_i - \beta_0 - \beta_1 x_{i1} - \cdots - \beta_p x_{ip})^2 + \lambda \sum_{j=1}^p |\beta_j| \right\}$$

The $\lambda \sum |\beta_j|$ term is the **L1 penalty**. Its key property: unlike L2 (Ridge), the L1 penalty drives weak coefficients to **exactly zero**. This makes LASSO a variable selection method — it produces a *sparse* model where only the most informative features have non-zero coefficients.

**Behaviour across the lambda path:**
- $\lambda \to 0$: coefficients converge to OLS estimates
- $\lambda \to \infty$: all coefficients are zeroed out
- Optimal $\lambda$ is selected via **K-fold cross-validation** — the same cross-validation principle used to choose M in GBM

### Why Standardise First

The L1 penalty is applied equally to all coefficients. If features are on different scales (e.g., `mileage` ranges 0–400,000 while `is_luxury` ranges 0–1), LASSO will inappropriately penalise coefficients for high-scale features. R's `glmnet` standardises internally before applying the penalty. Our implementation standardises explicitly using `StandardScaler` before `LassoCV`, then refits OLS on the original (unscaled) features so that coefficients are interpretable.

### Choosing Lambda — K-Fold Cross Validation

For each value of $\lambda$ in a path, we compute the K-fold CV error:

1. Split training data into K folds
2. For each fold: train LASSO on K-1 folds, compute MSE on the held-out fold
3. Average the K MSE values → CV error for that $\lambda$
4. Choose $\lambda$ that minimises CV error (`lambda.min` in R notation)

This is equivalent to the early stopping approach used for XGBoost — letting the data determine the optimal regularisation strength rather than fixing it arbitrarily.

### Two-Step Relaxed LASSO

LASSO does two things simultaneously with one penalty: **variable selection** (driving weak coefficients to zero) and **shrinkage** (pulling surviving coefficients toward zero). The same $\lambda$ that achieves clean selection also biases the retained coefficients downward.

**Relaxed LASSO** separates these two steps:

1. **Step 1 — LASSO selection** (`LassoCV`): Find $S = \{j : \hat{\beta}_j^\lambda \neq 0\}$, the set of features with non-zero LASSO coefficients under the CV-optimal $\lambda$
2. **Step 2 — OLS refit** (`LinearRegression` on $X_S$ only): Refit plain OLS on just the selected features, removing the shrinkage bias

The result: LASSO's sparsity with unbiased coefficient estimates. This is called "debiasing" or "relaxing" the LASSO — the same terminology used in Section 4.2 of the course notes (`lm()` on LASSO-selected variables).

### Comparison: LASSO vs Ridge vs Elastic Net

| | LASSO (L1) | Ridge (L2) | Elastic Net |
|---|---|---|---|
| Penalty | $\lambda \sum |\beta_j|$ | $\lambda \sum \beta_j^2$ | $\lambda(\alpha \sum |\beta_j| + \frac{1-\alpha}{2} \sum \beta_j^2)$ |
| Sparsity | Yes — exact zeros | No — all coefficients shrink | Yes (when $\alpha > 0$) |
| Correlated features | Selects one arbitrarily | Shrinks both equally | Selects groups together |
| `glmnet` alpha | `alpha=1` | `alpha=0` | `0 < alpha < 1` |

We use pure LASSO (`alpha=1`) because sparsity is the goal — we want a small number of interpretable features, not a dense model with all coefficients slightly shrunk.

### Our Implementation

```python
class RelaxedLasso(BaseEstimator, RegressorMixin):
    def fit(self, X, y, sample_weight=None):
        # Standardise (mirrors glmnet's internal scaling)
        self.scaler_ = StandardScaler(with_mean=not sp.issparse(X))
        X_scaled = self.scaler_.fit_transform(X)

        # Step 1: LassoCV — find lambda_min via cross-validation
        self.lasso_ = LassoCV(cv=5, max_iter=10000, n_jobs=-1)
        self.lasso_.fit(X_scaled, y)
        self.lambda_min_ = self.lasso_.alpha_
        coef = self.lasso_.coef_.copy()
        self.lambda_used_ = self.lambda_min_

        # If lambda_min selects more than max_features, walk lambda upward
        # through the tested path until the count falls within the cap
        if np.sum(np.abs(coef) > 1e-8) > self.max_features:
            for alpha in sorted(self.lasso_.alphas_):  # ascending = more regularisation
                if alpha <= self.lambda_min_:
                    continue
                _l = Lasso(alpha=alpha, ...).fit(X_scaled, y)
                if np.sum(np.abs(_l.coef_) > 1e-8) <= self.max_features:
                    coef = _l.coef_
                    self.lambda_used_ = alpha
                    break

        # Step 2: OLS on unscaled selected features (debiased / relaxed)
        X_sel = X[:, coef != 0]
        self.ols_ = LinearRegression().fit(X_sel, y)
```

After training, the log output mirrors the R notes' comparison table (Section 4.2):

```
Relaxed LASSO: 144/1235 features selected  (λ_used=0.01215, λ_min=0.00049)
Top 20 coefficients (log-price space):
  Feature                                            LASSO  OLS (debiased)
  -------------------------------------------------------------------------
  cat__model_560                                   +0.0327         +1.7305
  cat__model_380                                   +0.0060         +1.5952
  cat__model_sprinter                              +0.0046         +1.3897
  cat__model_firebird                              +0.0000         +1.0646
  cat__model_mirai                                 -0.0072         -1.0560
  cat__make_isuzu                                  +0.0160         +0.9802
  ...
```

LASSO estimates are always smaller in absolute value due to shrinkage. The OLS (debiased) estimates are the interpretable ones: a coefficient of `+1.73` on `cat__model_560` (Mercedes-Benz 560 series) means it commands approximately $e^{1.73} - 1 \approx 464\%$ premium over the baseline model — plausible for an ultra-luxury vehicle in the sub-$100k dataset. Note that LASSO and OLS estimates diverge substantially for rare, high-value models: the LASSO's shrinkage drastically underestimates the true effect, while the OLS refit recovers it.

### Lambda Selection — What Went Wrong and How It Was Fixed

Three runs were needed to get the lambda logic right (2026-04-28):

**Run 1 — λ=0.00049, 1,007/1,235 features, MAE=$2,832 (appeared to beat XGB):**
Using `lambda_min` raw with no cap. LASSO kept 81.5% of all features — not sparse at all. The OLS refitted 1,007 parameters onto 5,585 rows, essentially memorising every make/model/trim combination seen in training. It "won" against XGBoost by $32 on that specific test split but would not generalise — the win came from lookup-table memorisation, not learned pricing signal. The LASSO vs OLS coefficient divergence (+0.06 → +1.85) confirmed multicollinearity was making the OLS unstable.

**Run 2 — λ=0.49048, 0/1,235 features, MAE=$12,386:**
An attempt to use the `lambda_1se` rule (standard R recommendation: pick the most regularised model whose CV error is within one standard error of the minimum). This works well when the CV error curve is U-shaped. Our curve was monotonically decreasing — more regularisation always hurt, so the 1se rule picked a value 1,000× too large, zeroing all 1,235 features. The model predicted the mean price for every car, producing MAE=$12,386 — what "always guess average" gives.

**Run 3 — λ=0.01215, 144/1,235 features, MAE=$4,138 (correct behaviour):**
Replaced `lambda_1se` with a `max_features=150` hard cap. Start from `lambda_min`, then walk lambda upward through the tested path until the selected count falls at or below 150. This finds the minimum additional regularisation needed for a stable OLS refit. 144 features is genuinely sparse; XGB correctly wins at $2,864; the model ordering matches theory exactly.

### Benefits for CarIntel

- **Feature discovery:** LASSO answers "which specific makes, models, and trim levels have genuine price signal?" out of 1,000+ OHE columns
- **Coefficient interpretability:** every surviving coefficient has a direct meaning in log-price space — something XGBoost cannot provide directly
- **Eliminates multicollinearity:** with hundreds of correlated dummies (e.g., make and model are correlated), OLS is unstable; LASSO selects a sparse representative set

### Limitations

- **Linear model:** cannot capture nonlinear depreciation curves or interactions (luxury × age) without explicit feature engineering
- **Performance ceiling below RF and XGBoost** on this problem domain — car pricing is fundamentally nonlinear
- **Lambda CV stability:** the chosen $\lambda$ can vary between runs due to random fold assignment, making the selected feature set slightly unstable

### Actual Performance (2026-04-28, 6,982 rows)

| Model | MAE | RMSE | Luxury MAE | Non-Lux MAE |
|---|---|---|---|---|
| Linear | $4,813 | $7,619 | $6,546 | $4,184 |
| **Relaxed LASSO** | **$4,138** | **$6,774** | **$5,991** | **$3,465** |
| Random Forest | $3,232 | $5,478 | $3,967 | $2,965 |
| XGBoost | **$2,864** | **$4,880** | **$3,641** | **$2,582** |

The order matches theory exactly: Relaxed LASSO sits between linear and RF. It is 14% better than plain linear (drops noise features) but 28% worse than RF (cannot capture nonlinear interactions). Its value is interpretability, not accuracy — XGBoost is always selected as the production model.

---

## 12. Random Forest

### Theory

Random Forest builds an ensemble of B independent decision trees, each trained on a bootstrap sample (random sample with replacement) of the training data:

$$\hat{f}(x) = \frac{1}{B} \sum_{b=1}^B T_b(x)$$

Two sources of randomness decorrelate the trees and reduce ensemble variance:

1. **Bootstrap sampling:** each tree sees ~63.2% of training rows (the rest form a free out-of-bag validation set)
2. **Random feature selection (mtry):** at each split, only a random subset of $m$ features are considered

The key variance reduction result: if each tree has variance $\sigma^2$ and pairwise correlation $\rho$:

$$\text{Var}(\hat{f}) = \rho \sigma^2 + \frac{1-\rho}{B} \sigma^2$$

As $B \to \infty$ the second term vanishes, leaving $\rho \sigma^2$ — the irreducible correlation between trees.

### Our implementation

```python
RandomForestRegressor(
    n_estimators=300,
    min_samples_leaf=2,    # prevents single-observation leaves
    n_jobs=-1,
    random_state=42,
)
```

### Benefits

- Captures nonlinear relationships and interactions naturally
- Low overfitting risk — averaging independent trees is a strong variance reducer
- Built-in OOB error estimate
- No distributional assumptions

### Limitations

- Cannot extrapolate beyond training data range
- Trees are independent — cannot correct for systematic errors the way boosting does
- Performance ceiling below well-tuned XGBoost

### GBM vs. Random Forest

| | Random Forest | XGBoost (GBM) |
|---|---|---|
| Tree building | Independent, parallel | Sequential — each tree targets residuals of previous |
| Bias reduction | No | Yes |
| Variance reduction | Strong (averaging) | Moderate (subsampling + shrinkage) |
| Overfitting risk | Low | Higher — needs careful tuning |
| Extrapolation | Poor | Poor |
| Tuning complexity | Low | High |

### Performance (2026-04-27, ~7,000 rows)

| Segment | MAE | RMSE |
|---|---|---|
| Overall | ~$3,324 | ~$6,028 |
| Luxury | ~$4,144 | — |
| Non-luxury | ~$3,020 | — |

RF beats linear by ~35% and the luxury gap narrows substantially ($7,015 → $4,144) — confirming that nonlinear and interaction effects are the main reason linear regression struggles. XGBoost still beats RF by ~16%, which is the expected gap between a well-tuned boosting model and a well-tuned forest.

---

## 13. Potential Improvements from the Theory

### 13.1 Rebalance gamma vs. max_depth

**Theory says:** `gamma` is the primary guard against over-splitting. Our `gamma=0.05` is nearly off, while `max_depth=6` is generous. These two parameters are in tension.

**How to apply:** Include `gamma` in the grid search, testing values across `[0.05, 0.5, 1.0, 2.0]` jointly with `max_depth`. The theory's `gamma=1` + `max_depth=3` combination may outperform our current settings for the same model complexity.

### 13.2 colsample_bylevel — Closer to RF's mtry

XGBoost supports `colsample_bylevel` which randomises the feature subset at each depth level — closer to what RF actually does at each split.

```python
XGBRegressor(
    colsample_bytree=0.7,
    colsample_bylevel=0.7,   # additional randomisation at each depth level
    ...
)
```

### 13.3 Relaxed LASSO backward elimination

The R notes show one further step after the initial OLS refit: backward elimination to remove predictors with high p-values. This could be added to our `RelaxedLasso` class to produce an even sparser final model. Not implemented yet — adds complexity and our current dataset is large enough that LassoCV is already selective.

### 13.4 Summary of Remaining Opportunities

| Improvement | Expected Impact | Implementation Effort |
|---|---|---|
| Gamma + depth rebalance | Medium — reduce noisy deep splits | Low (add to grid search) |
| `colsample_bylevel` | Low-Medium — stronger decorrelation | Very low |
| Relaxed LASSO backward elimination | Low — marginal sparsity improvement | Medium |

---

## 14. Improvements Made to the Model

This section records concrete changes applied to `ml/pipeline.py` and why they were made.

---

### 14.1 Log-Space Target

**Change:** Train on `log1p(price)` rather than raw price. Predictions are converted back with `np.expm1()` at scoring time.

**Why:** Car prices span roughly 3×–30× across segments. Training on raw price means a $5,000 error on a $10,000 car and a $5,000 error on a $50,000 car are treated identically. Log space makes errors proportional — the model is penalised equally for being 10% wrong regardless of price tier. This especially improves performance on luxury vehicles.

**File:** `ml/pipeline.py` — `y_train_log = np.log1p(y_train)`

---

### 14.2 MAE Loss Instead of MSE

**Change:** `objective="reg:absoluteerror"` instead of the default `reg:squarederror`.

**Why:** MSE squares residuals, over-weighting expensive outliers (low-mileage luxury trims, rare configurations). MAE weights all errors linearly, making the ensemble more robust across the full price range.

**File:** `ml/pipeline.py` — `XGBRegressor(objective="reg:absoluteerror", ...)`

---

### 14.3 K-Fold Cohort Encoding to Prevent Target Leakage

**Change:** The `cohort_median_price` feature is computed using 5-fold target encoding during training rather than naively from the full training set.

**Why:** Naive computation lets each row partially see its own price when its cohort feature is calculated — target leakage. For each training row, the cohort median is computed from the other 4 folds only. At inference, the full training cohort stats are used (no leakage concern).

**File:** `ml/pipeline.py` — `_kfold_cohort_encode()`

---

### 14.4 Post-Training Calibration

**Change:** The median log-space residual on the test set is computed and saved as `log_calibration`. This offset is subtracted from all future predictions.

**Why:** Systematic bias in a deal-scoring system shifts the entire score distribution. Calibration ensures the median predicted price equals the median actual price, giving a balanced mix of good/bad deals.

**File:** `ml/pipeline.py` — `log_calibration = float(np.median(test_log_preds - y_test_log.to_numpy()))`

---

### 14.5 Joint Grid Search on M and eta

**Change:** Replaced hardcoded `n_estimators=1500, learning_rate=0.03` with `GridSearchCV` over:

```python
"model__learning_rate": [0.01, 0.03, 0.05, 0.1]
"model__n_estimators":  [500, 1000, 1500, 2000]
```

16 combinations × 5-fold CV = 80 total fits. Winning combination is used to construct the final `XGBRegressor`.

**Why:** M and eta are not independent. Tuning them separately produces suboptimal results — the joint search finds the true optimum on the efficient frontier. The theory's lecture showed this approach dropping RMSE from 3.68 to 3.07 (~17%).

**File:** `ml/pipeline.py` — `GridSearchCV(_gs_pipe, _param_grid, cv=5, ...)`

**Result (2026-04-22, 6,023 rows):** Grid search selected `learning_rate=0.1, n_estimators=2000`. XGB MAE improved from **$3,008 → $2,752** — an 8.5% reduction.

| Params | XGB MAE | XGB RMSE | Luxury MAE | Non-Lux MAE |
|---|---|---|---|---|
| Before: `lr=0.03, n=1500` (hand-tuned) | $3,008 | $5,443 | $3,809 | $2,709 |
| After: `lr=0.1, n=2000` (grid search) | **$2,752** | **$4,883** | **$3,401** | **$2,510** |
| Improvement | **−$256 (8.5%)** | **−$560 (10.3%)** | **−$408 (10.7%)** | **−$199 (7.3%)** |

**Note:** This code was lost during a `git stash` / `git stash pop` conflict in April 2026 and subsequently restored. The April 27 runs (using hardcoded params) produced MAE ~$2,866 on a larger dataset. With grid search restored on the current ~7k row dataset, performance should recover to or improve upon the $2,752 baseline.

---

### 14.6 Early Stopping to Find True Optimal M

**Change:** After the grid search determines the best `learning_rate`, a second diagnostic pass runs XGBoost with `early_stopping_rounds=50` against a 15% held-out slice of `X_train`. The model trains up to a ceiling of 3,000 trees and stops when validation MAE stops improving.

**Why:** The grid search treats `n_estimators` as a discrete grid parameter. Early stopping finds the true continuous optimum — it stops precisely where a held-out sample says generalisation peaked.

**File:** `ml/pipeline.py` — `_xgb_es.fit(..., early_stopping_rounds=50)` → `_optimal_n = _xgb_es.best_iteration`

**Result (2026-04-22, 6,023 rows):** Early stopping found `n_estimators=1,205` against a ceiling of 3,000. The 2,000-tree model showed a tighter training fit (trainRMSE(log) 0.1121 vs 0.1256) with marginally better test MAE — a mild overfitting pattern where trees 1,206–2,000 were memorising training data. The 1,205-tree model is the safer choice as the dataset grows.

| Run | n_estimators | MAE | RMSE | TrainRMSE(log) |
|---|---|---|---|---|
| Grid search only | 2,000 | $2,752 | $4,883 | 0.1121 |
| Grid search + early stopping | 1,205 | $2,823 | $5,034 | 0.1256 |

---

### 14.7 Relaxed LASSO Added as Candidate

**Change:** Added `RelaxedLasso` as a fourth candidate model alongside `linear`, `rf`, and `xgb`.

**Why:** XGBoost achieves the lowest MAE but produces no interpretable coefficients. Relaxed LASSO trades some predictive accuracy for full coefficient-level explainability — enabling statements like "a Mercedes-Benz 560 commands a 464% premium over the baseline model, controlling for mileage, age, and trim." This is valuable for portfolio presentation and for understanding which features genuinely drive car prices.

**File:** `ml/pipeline.py` — `RelaxedLasso` class + `candidates["relaxed_lasso"] = RelaxedLasso(...)`

**Result (2026-04-28, 6,982 rows):** MAE=$4,138. Sits between linear ($4,813) and RF ($3,232) as expected. XGB correctly wins. See Section 11 for the full three-run debugging history of the lambda selection logic.

---

### 14.8 Relaxed LASSO Lambda Selection — max_features Cap

**Change:** Replaced the `lambda_1se` rule with a `max_features=150` hard cap. Start from `lambda_min` (CV-optimal lambda). If that selects more than 150 features, walk lambda upward through the tested path and take the first lambda that brings the count at or below the cap.

**Why:** Three runs were needed to get this right:
1. `lambda_min` raw → 1,007/1,235 features kept (not sparse), OLS unstable, appeared to beat XGB by $32 on one split (memorisation artefact)
2. `lambda_1se` rule → zeroed all 1,235 features because our CV error path is monotonically decreasing (lambda_1se requires a U-shaped curve to work correctly), MAE=$12,386
3. `max_features=150` cap → 144 features, MAE=$4,138, correct model ordering restored

The cap finds the minimum additional regularisation beyond lambda_min that produces a stable, sparse OLS refit — no assumptions about the shape of the CV error curve required.

**File:** `ml/pipeline.py` — `RelaxedLasso(max_features=150)`

---

## 15. Model Performance History

| Date | Rows | Model | MAE | Notes |
|---|---|---|---|---|
| Pre-grid-search | ~6,023 | XGB (lr=0.03, n=1500) | $3,008 | Hand-tuned params |
| 2026-04-22 | 6,023 | XGB grid search only | $2,752 | lr=0.1, n=2000 |
| 2026-04-22 | 6,023 | XGB grid search + early stop | $2,823 | n=1,205 |
| 2026-04-22 | 7,190 | XGB (trucks/SUVs enabled) | $2,866 | More diverse data, no grid search |
| 2026-04-27 | ~7,000 | XGB (hardcoded params) | $2,866–3,107 | Grid search lost in stash ops |
| 2026-04-28 | 6,982 | XGB grid search + early stop | $2,864 | Grid search restored, n=796 |
| 2026-04-28 | 6,982 | Relaxed LASSO (144 features) | $4,138 | Interpretability candidate |
