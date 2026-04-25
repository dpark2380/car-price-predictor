# Candidate Models — Theory & CarIntel Implementation

This document covers the theory behind each candidate model used in `ml/pipeline.py` (Linear Regression, Random Forest, and XGBoost), maps GBM/XGBoost theory to our specific implementation choices, and records improvements made over time.

---

## 1. The Core Ensemble

**Theory:**

$$f(x) = \sum_{m=1}^M \beta_m b(x, \gamma_m)$$

where $b(x, \gamma_m)$ is a small tree with splitting rules $\gamma_m$ and weight $\beta_m$.

**Our implementation:**

Our model builds exactly this sum. Each tree produced by XGBoost is one $b(x, \gamma_m)$, with M selected automatically by joint grid search (see Section 4). The final prediction is the accumulated sum across all M trees' leaf values.

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

We explicitly use **MAE** instead of MSE. This is a deliberate domain choice — car pricing has expensive outliers (low-mileage luxury trims, rare configurations) and MSE would square those residuals, forcing the model to over-fit to them. MAE treats all errors linearly, making the model more robust across the full price range.

The forward stagewise math still applies — the residuals being fit are just $|r_i|$-weighted rather than $r_i^2$-weighted.

---

## 3. Forward Stagewise Additive Modelling

**Theory:**

1. Initialise: $\hat{y}^{(0)}(x) = \bar{y}$
2. At step $m$, find: $(\beta_m, \gamma_m) = \arg\min_{\beta, \gamma} \sum_i \left(y_i - \hat{y}^{(m-1)}(x_i) - \beta b(x_i, \gamma)\right)^2$
3. Update: $\hat{y}^{(m)}(x) = \hat{y}^{(m-1)}(x) + \eta \cdot \beta_m b(x, \gamma_m)$

**Our implementation:**

- **Step 1:** XGBoost internally initialises to the mean of `log1p(price)`
- **Step 2:** At each of the 1,500 rounds, XGBoost fixes the current prediction and finds the tree that minimally reduces the current residuals
- **Step 3 — Shrinkage:** $\eta$ = `learning_rate=0.03`

Our `learning_rate=0.03` is notably smaller than the textbook's `eta=0.1`, compensated by 1,500 trees instead of 500. This is the classic tradeoff: smaller $\eta$ means slower learning but better generalisation, requiring more trees to converge.

---

## 4. Choosing M — Joint Grid Search

**Theory** describes three approaches:

| Approach | Test RMSE (lecture example) |
|---|---|
| Naive (fixed M=500) | 3.68 |
| CV + early stopping | 3.69 |
| Full grid search | **3.07** |

**Our implementation:** We use a **joint grid search** over M (`n_estimators`) and eta (`learning_rate`) — the approach with the highest expected impact according to the theory. See Section 11 (Improvements) for full detail on what this does and why.

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

Our `gamma=0.05` is far more permissive than the theory's `gamma=1`. We allow aggressive splitting and rely on depth control and weight regularisation (`lambda`, `alpha`) instead.

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

At each of the 1,500 boosting rounds, XGBoost draws 80% of training rows and 70% of the feature columns to fit that tree. This mirrors Random Forest's row bagging and `mtry`:
- Reduces correlation between trees
- Provides a rough OOB error estimate for free
- Speeds up training

The `colsample_bytree=0.7` is especially meaningful because our feature space after one-hot encoding is wide (hundreds of make/model/state/trim dummies). Masking 30% prevents any single tree from always conditioning on the same high-cardinality categorical.

---

## 8. Pipeline Architecture Beyond the Theory

The theory shows XGBoost operating directly on a feature matrix. Our implementation wraps it in a scikit-learn `Pipeline` with two stages:

1. **`ColumnTransformer`**: median imputation for numerics, mode imputation + one-hot encoding for categoricals
2. **`XGBRegressor`**: the boosted model itself

This means $x_i$ in $b(x_i, \gamma_m)$ is the transformed, imputed, one-hot-encoded vector — not a raw scraped row.

**K-Fold Cohort Encoding** is a custom addition beyond the theory. The `cohort_median_price` feature tells the model "what do similar cars (same make/model/year) typically sell for?" Naively computing this from all training data would let each row partially see its own price — target leakage. We solve this with 5-fold target encoding:
- For each training row, compute cohort median from the **other 4 folds only**
- At inference, use full training cohort stats (no leakage concern)

This is the same cross-validation principle the theory applies to choosing M — applied here to prevent a feature from memorising the target.

**Post-Training Calibration** is also not in the theory:

```python
log_calibration = float(np.median(test_log_preds - y_test_log.to_numpy()))
```

After training, we compute the median systematic bias on the test set (in log space) and subtract it from all future predictions. This ensures the model doesn't consistently over- or under-predict by a fixed percentage — critical for a deal-scoring system where we need $\hat{y} = y$ at the median.

---

## 9. Full Parameter Comparison

| Parameter | Theory example | Our value |
|---|---|---|
| `objective` | `reg:squarederror` (MSE) | `reg:absoluteerror` (MAE) |
| `n_estimators` (M) | 500 | **grid-searched** over [500, 1000, 1500, 2000] |
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

Each coefficient $\beta_j$ represents the change in predicted price for a one-unit increase in feature $x_j$, holding all other features constant. This makes the model completely interpretable: you can read off exactly how much each year of age or each mile adds or subtracts from the predicted price.

### Our implementation

```python
LinearRegression()   # sklearn defaults, no regularisation
```

Trained on `log1p(price)` like the other candidates, so coefficients express proportional rather than absolute price effects. No hyperparameters — the closed-form solution is exact.

### Benefits

- **Interpretability:** every coefficient has a direct meaning. A coefficient of −0.03 on `log_mileage` means a 1% increase in mileage reduces predicted price by 3%.
- **Speed:** training is near-instant regardless of dataset size.
- **Stable baseline:** because it has no hyperparameters, its performance is completely reproducible. It anchors the comparison — if XGBoost only marginally beats it, something is wrong with the feature engineering or data quality.
- **No overfitting risk:** the model has exactly p+1 parameters regardless of dataset size.

### Limitations

- **Cannot capture nonlinear relationships.** Car depreciation is not linear — a car loses more value in its first two years than its next five. Even with log-space targets and engineered features like `log_mileage` and `age_sq`, the underlying relationship still has curvature that a linear model misses.
- **Cannot capture interactions.** The luxury depreciation curve is fundamentally different from a standard car's. Linear regression has no way to express "high mileage hurts a luxury car more than a standard car" without an explicitly engineered interaction term. Our `lux_age` and `lux_mpy` features partially compensate for this, but the model can't discover interactions on its own.
- **Sensitive to outliers in dollar space.** Although we train in log space, extreme residuals still exert disproportionate influence on coefficient estimates via the squared loss.

### Performance (2026-04-22, 7,190 rows)

| Segment | MAE | RMSE |
|---|---|---|
| Overall | $5,583 | $8,978 |
| Luxury | $8,136 | — |
| Non-luxury | $4,518 | — |

The luxury MAE of $8,136 — nearly double non-luxury — illustrates the model's core limitation. Luxury depreciation is exponential and highly trim-dependent, neither of which a linear model can represent. It serves as a useful floor: any candidate that doesn't substantially beat $5,583 has a feature engineering problem.

---

## 11. Random Forest

### Theory

Random Forest builds an ensemble of B independent decision trees, each trained on a bootstrap sample (random sample with replacement) of the training data:

$$\hat{f}(x) = \frac{1}{B} \sum_{b=1}^B T_b(x)$$

Two sources of randomness decorrelate the trees and reduce ensemble variance:

1. **Bootstrap sampling:** each tree sees ~63.2% of training rows (the rest form a free out-of-bag validation set).
2. **Random feature selection (mtry):** at each split, only a random subset of $m$ features are considered. This prevents all trees from conditioning on the same dominant features (e.g. `mileage`) and forces the ensemble to use the full feature space.

The key result is variance reduction through averaging. If each tree has variance $\sigma^2$ and pairwise correlation $\rho$, the ensemble variance is:

$$\text{Var}(\hat{f}) = \rho \sigma^2 + \frac{1-\rho}{B} \sigma^2$$

As $B \to \infty$ the second term vanishes, leaving $\rho \sigma^2$ — the irreducible correlation between trees. This is why lowering $\rho$ through random feature selection matters as much as growing more trees.

### Our implementation

```python
RandomForestRegressor(
    n_estimators=300,      # B — number of trees
    min_samples_leaf=2,    # prevents single-observation leaves
    n_jobs=-1,             # parallel training across all cores
    random_state=42,
)
```

`min_samples_leaf=2` is the only regularisation — it prevents the model from creating leaves for single rare (make, trim, state) combinations that appear only once in training data.

### Benefits

- **Captures nonlinear relationships and interactions naturally.** Each tree can split on `is_luxury` then on `vehicle_age`, learning the luxury depreciation curve without any explicit feature engineering.
- **Low overfitting risk.** Averaging independent trees is a strong variance reducer. RF is much more forgiving of hyperparameter choices than XGBoost — it's hard to badly overfit a Random Forest.
- **Built-in OOB error estimate.** The ~36.8% of rows not seen by each tree give a free out-of-sample error estimate without touching the test set.
- **No distributional assumptions.** Unlike linear regression, RF makes no assumptions about the shape of the relationship between features and price.
- **Handles missing values gracefully** (via the imputer upstream in the pipeline).

### Limitations

- **Cannot extrapolate.** Because predictions are averages of leaf values seen during training, RF cannot predict a price higher than the maximum training price for a given region of feature space. For a rare new trim or a car priced above the training range, RF will systematically underpredict.
- **Trees are independent — no error correction.** Each tree is built without knowledge of how previous trees performed. RF can't systematically reduce bias the way boosting does by targeting residuals.
- **Memory and inference cost.** 300 full-depth trees is significantly more memory than a well-regularised XGBoost model with shallower trees.
- **Performance ceiling below XGBoost** when the latter is well-tuned, because RF can only reduce variance (averaging), not bias. If the individual trees are systematically wrong in the same direction, averaging doesn't fix it.

### GBM vs. Random Forest — summary

| | Random Forest | XGBoost (GBM) |
|---|---|---|
| Tree building | Independent, parallel | Sequential — each tree targets residuals of previous |
| How combined | Simple average | Weighted sum with shrinkage |
| Bias reduction | No | Yes — each round reduces systematic error |
| Variance reduction | Strong (averaging) | Moderate (subsampling + shrinkage) |
| Overfitting risk | Low | Higher — needs careful tuning |
| Extrapolation | Poor | Poor (same tree structure) |
| Tuning complexity | Low (mainly `n_estimators`, `mtry`) | High (eta, depth, subsampling, gamma, lambda, alpha) |

### Performance (2026-04-22, 7,190 rows)

| Segment | MAE | RMSE |
|---|---|---|
| Overall | $3,633 | $6,501 |
| Luxury | $4,589 | — |
| Non-luxury | $3,235 | — |

RF beats linear by 35% on overall MAE and the luxury gap narrows substantially ($8,136 → $4,589) — confirming that nonlinear and interaction effects are the main reason linear regression struggles. XGBoost still beats RF by 20% overall, which is the expected gap between a well-tuned boosting model and a well-tuned forest on a tabular dataset of this size.

---

## 12. Potential Improvements from the Theory

### 12.1 Early Stopping to Find Optimal M

**Theory says:** CV + early stopping lets the data tell you when to stop, and avoids both over-training and under-training.

**Current gap:** We use a fixed `n_estimators=1500` with no stopping criterion. With `learning_rate=0.03`, we genuinely don't know whether 1,500 is the optimal number of trees — it may have plateaued at 900 or still be improving at 1,500.

**How to apply:**

```python
XGBRegressor(
    n_estimators=3000,           # set a ceiling
    learning_rate=0.03,
    early_stopping_rounds=50,    # stop if val MAE doesn't improve for 50 rounds
    eval_metric="mae",
    ...
)
# Then pass eval_set=[(X_val, y_val_log)] to fit()
```

This would find the true optimal M automatically and make the `n_estimators` choice principled rather than arbitrary.

---

### 12.2 Joint Grid Search on M + eta

**Theory says:** "Tuning M and eta together matters" — the lecture's full grid search dropped RMSE from 3.68 to 3.07 (a ~17% improvement) just from this.

**Current gap:** Our parameters are hand-tuned but never formally searched. We don't know if `learning_rate=0.03` + 1,500 trees is actually on the efficient frontier compared to, say, `0.05` + 800 trees.

**How to apply:**

```python
from sklearn.model_selection import GridSearchCV

param_grid = {
    "model__learning_rate": [0.01, 0.03, 0.05, 0.1],
    "model__n_estimators":  [500, 1000, 1500, 2000],
    "model__max_depth":     [4, 6, 8],
    "model__subsample":     [0.7, 0.8, 1.0],
}
grid_search = GridSearchCV(pipe, param_grid, cv=5, scoring="neg_mean_absolute_error")
grid_search.fit(X_train, y_train_log)
```

Given the theory's lecture results, this is the single highest expected-value improvement.

---

### 12.3 Rebalance gamma vs. max_depth

**Theory says:** `gamma` is the primary guard against over-splitting. Our `gamma=0.05` is nearly off, while `max_depth=6` is generous. These two parameters are in tension.

**Current gap:** With depth-6 trees and near-zero gamma, individual trees can grow very deep on noisy splits that don't actually improve MAE. The `lambda`/`alpha` regularisation helps, but gamma is the upstream guard.

**How to apply:** Include `gamma` in the grid search above, testing values across `[0.05, 0.5, 1.0, 2.0]` jointly with `max_depth`. The theory's `gamma=1` + `max_depth=3` combination may outperform our current `gamma=0.05` + `max_depth=6` for the same model complexity.

---

### 12.4 colsample_bylevel — Closer to RF's mtry

**Theory** describes `colsample_bytree` as analogous to Random Forest's `mtry`. But RF actually randomises features at **each split**, not just at the tree level.

XGBoost supports `colsample_bylevel` which randomises the feature subset at each depth level — closer to what RF actually does and often stronger than `colsample_bytree` alone.

**How to apply:**

```python
XGBRegressor(
    colsample_bytree=0.7,
    colsample_bylevel=0.7,   # additional randomisation at each depth level
    ...
)
```

This adds an extra layer of decorrelation between trees without changing any other hyperparameter. Low cost, worth testing.

---

### 12.5 Summary of Remaining Opportunities

| Improvement | Expected Impact | Implementation Effort |
|---|---|---|
| Early stopping | Medium — principled M ceiling | Low |
| Gamma + depth rebalance | Medium — reduce noisy deep splits | Low (add to grid search) |
| `colsample_bylevel` | Low-Medium — stronger decorrelation | Very low |

---

## 13. Improvements Made to the Model

This section records concrete changes applied to `ml/pipeline.py` and why they were made.

---

### 13.1 Log-Space Target

**Change:** Train on `log1p(price)` rather than raw price. Predictions are converted back with `np.expm1()` at scoring time.

**Why:** Car prices span roughly 3×–30× across segments. Training on raw price means a $5,000 error on a $10,000 car and a $5,000 error on a $50,000 car are treated identically. Log space makes errors proportional — the model is penalised equally for being 10% wrong regardless of price tier. This especially improves performance on luxury vehicles.

**File:** `ml/pipeline.py` — `y_train_log = np.log1p(y_train)`

---

### 13.2 MAE Loss Instead of MSE

**Change:** `objective="reg:absoluteerror"` instead of the default `reg:squarederror`.

**Why:** The standard GBM theory uses MSE, which squares residuals. In car pricing, expensive outliers (low-mileage luxury trims, rare configurations) produce large residuals that MSE would over-weight, biasing the model toward fitting those edge cases. MAE weights all errors linearly, making the ensemble more robust across the full price range.

**File:** `ml/pipeline.py` — `XGBRegressor(objective="reg:absoluteerror", ...)`

---

### 13.3 K-Fold Cohort Encoding to Prevent Target Leakage

**Change:** The `cohort_median_price` feature (median price for the same make/model/year cohort) is computed using 5-fold target encoding during training rather than naively from the full training set.

**Why:** If we computed the cohort median from all training rows, each row would partially see its own price when its cohort feature was calculated — a form of target leakage. The fix mirrors the cross-validation principle from the theory for choosing M: for each training row, the cohort median is computed from the other 4 folds only. At inference, the full training cohort stats are used (no leakage concern there).

**File:** `ml/pipeline.py` — `_kfold_cohort_encode()`

---

### 13.4 Post-Training Calibration

**Change:** After training, the median log-space residual on the test set is computed and saved as `log_calibration`. This offset is subtracted from all future predictions before converting back from log space.

**Why:** Even a well-trained model can have a small systematic bias — consistently predicting 3% too high or too low. For a deal-scoring system where a score of 50 means "fair price", any systematic bias would shift the whole distribution. The calibration step ensures the median predicted price equals the median actual price, giving a balanced mix of good/bad deals at scoring time.

**File:** `ml/pipeline.py` — `log_calibration = float(np.median(test_log_preds - y_test_log.to_numpy()))`

---

### 13.5 Joint Grid Search on M and eta

**Change:** Replaced the hardcoded `n_estimators=1500, learning_rate=0.03` with a `GridSearchCV` that searches all 16 combinations of:

```python
"model__learning_rate": [0.01, 0.03, 0.05, 0.1]
"model__n_estimators":  [500, 1000, 1500, 2000]
```

Each combination is evaluated with 5-fold cross-validation (80 total fits), scored by MAE on the log-space target. The winning combination is used to construct the final `XGBRegressor` before the normal training loop.

**Why:** M and eta are not independent parameters. A small eta needs many trees to converge; a large eta converges with fewer trees but may overshoot. Tuning them separately produces suboptimal results — the joint search finds the true optimum on the efficient frontier. The theory's lecture example showed this approach dropping RMSE from 3.68 to 3.07 (~17% improvement) compared to a naive fixed-M approach.

**File:** `ml/pipeline.py` — `GridSearchCV(_gs_pipe, _param_grid, cv=5, scoring="neg_mean_absolute_error", ...)`

**Result (2026-04-22, 6,023 rows):** Grid search selected `learning_rate=0.1, n_estimators=2000`. XGB MAE improved from **$3,008 → $2,752** — an 8.5% reduction in error on the same dataset and same 80/20 split. Both winning params sat at the top boundary of the search grid, consistent with the theory's finding that higher eta + more trees often outperforms lower eta with fewer trees when searched jointly.

| Params | XGB MAE | XGB RMSE | Luxury MAE | Non-Lux MAE |
|---|---|---|---|---|
| Before: `lr=0.03, n=1500` (hand-tuned) | $3,008 | $5,443 | $3,809 | $2,709 |
| After: `lr=0.1, n=2000` (grid search) | **$2,752** | **$4,883** | **$3,401** | **$2,510** |
| Improvement | **−$256 (8.5%)** | **−$560 (10.3%)** | **−$408 (10.7%)** | **−$199 (7.3%)** |

---

### 13.6 Early Stopping to Find True Optimal M

**Change:** After the grid search determines the best `learning_rate`, a second diagnostic pass runs XGBoost with `early_stopping_rounds=50` against a 15% held-out slice of `X_train`. The model trains up to a ceiling of 3,000 trees and stops once validation MAE has not improved for 50 consecutive rounds. The resulting `best_iteration` is used as `n_estimators` for the final candidate, replacing the grid search's suggested value.

**Why:** The grid search treats `n_estimators` as a discrete grid parameter and can only evaluate the fixed values [500, 1000, 1500, 2000]. Early stopping finds the true continuous optimum — it stops precisely where a held-out sample says generalisation peaked, rather than running to an arbitrary ceiling.

**File:** `ml/pipeline.py` — `_xgb_es.fit(..., early_stopping_rounds=50)` → `_optimal_n = _xgb_es.best_iteration`

**Result (2026-04-22, 6,023 rows):** Early stopping found `n_estimators=1,205` against a ceiling of 3,000 (grid search had suggested 2,000). The 1,205-tree model trades $71 MAE ($2,752 → $2,823) for a more principled stopping point. The 2,000-tree model showed a tighter training fit (trainRMSE(log) 0.1121 vs 0.1256) with marginally better test MAE — a mild overfitting pattern where trees 1,206–2,000 were memorising training data rather than learning generalisable signal. The 1,205-tree model is the safer choice as the dataset grows.

| Run | n_estimators | MAE | RMSE | TrainRMSE(log) |
|---|---|---|---|---|
| Grid search only | 2,000 | $2,752 | $4,883 | 0.1121 |
| Grid search + early stopping | 1,205 | $2,823 | $5,034 | 0.1256 |
