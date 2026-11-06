# Used-car price model: error-reduction research

Run date 2026-10-09. All experiments ran on a copy of `car_intel.db` (training_pool_v, 180-day window ending at max(last_seen); 9,611 rows), using the repo's own `_build_features_raw`, cohort encoding and `_vin_split` (seed 42, 6150/1540/1923). Nothing in the repo except this file was touched.

## Baseline reproduction

Running `ml.pipeline.train()` on the DB copy reproduced the production log exactly: XGB test MAE $3,702.0, RMSE $6,327.9, luxury $5,054.4 (n=631), non-luxury $3,041.6 (n=1292); RF $3,857; xgb lr=0.05, n=822. A hand-written replica of the pipeline (`lib.py: fit_eval`) gives the same $3,702.04. "Baseline" below means this config. Three-seed XGB noise on the same split is about +/- $10 to $20 MAE (the baseline averages $3,683 over seeds 42-44 at n=822 and $3,664 with early stopping on val).

## Summary

Top changes, ranked by measured gain (test MAE, fixed split, 3-seed XGB averages unless noted; each delta is measured against its own reference row in the table, so gains are not additive):

| Rank | Change | Test MAE | Delta |
|---|---|---|---|
| 1 | Add `dealer_name` as a categorical (F7b/F7) | $2,991 vs $3,143 | -$152 (-4.8%) on top of the new features |
| 2 | Add a kNN "comparable sales" price feature (OOF) (F5) | $3,222 vs $3,378 | -$157 (-4.6%) |
| 3 | Switch XGB objective from `reg:absoluteerror` to `reg:squarederror` on the same log target (O) | $3,378 vs $3,664 | -$286 (-7.8%) |
| 4 | Sqrt-price target instead of log (F7 sqrt) | $2,937 vs $3,014 | -$77 (-2.6%) |
| 5 | Blend XGB + CatBoost (native categoricals) 50/50 | $2,805 vs $2,928 (single seed) | -$123 (-4.2%) |

Other gains: more history in training (older than 180 days, D4) -$270; hierarchical OOF cohort medians (F2) -$67; fractional age at listing (F1) -$18 (noise level); upweighting luxury rows 3x -$77 overall, luxury MAE -$118.

**Recommended combined config**: log or sqrt target with squared-error XGB, new features (F7 set below), 50/50 blend of XGB and CatBoost. Seed-42 split: test MAE **$2,805** (RMSE $4,721, luxury $3,958, non-luxury $2,241) vs baseline $3,702 (RMSE $6,328, luxury $5,054, non-lux $3,042), which is -24%. It held on two other VIN-grouped splits (table "Robustness"): $3,950 to $2,790 and $3,639 to $2,653. Without `dealer_name` (see the caveat) the blend gives $2,934 on seed 42 (-21%), $2,937 on split 1 and $2,768 on split 2. Adding older rows to train (D4) gave a further -$270 on XGB alone but was not combined into the recommended number.

**Biggest caveat**: `dealer_name` encodes who is selling. Hertz San Diego alone is 1,518 of 12,519 pooled rows, and a fleet seller prices very consistently, so the model learns "Hertz price". That lowers MAE, but it also means an overpriced listing from a dealer who always overprices is predicted as expensive, which weakens the "deal score" signal. Use the dealer-free variant if the product goal is spotting bargains rather than minimizing MAE. I did not test this effect on deal-score quality.

No leakage was found in the existing pipeline: the split is VIN-grouped, cohort features are out-of-fold on train and train-only for val/test, and calibration uses val only. One thing to know: `training_pool_v` keeps only the latest row per VIN, so repeated-VIN dedup is already done (keep-latest).

## Results table (test set, fixed VIN-grouped split seed 42)

Delta is vs the baseline row in the same block. Blocks differ in reference because each idea was tested on top of the best-so-far config, so compare within a block. "3s" is the mean of XGB seeds 42/43/44 with early stopping (lr 0.05) on the val split; `abs` = `reg:absoluteerror`, `sq` = `reg:squarederror`.

### Block 1: original features, XGB abs/log (the production recipe)

| Experiment | MAE | RMSE | Lux MAE | Non-lux MAE | Delta MAE |
|---|---|---|---|---|---|
| Production run (single seed, grid-searched n=822) | 3,702 | 6,328 | 5,054 | 3,042 | ref |
| B0 same, 3 seeds, n=822 | 3,683 | 6,324 | 5,013 | 3,033 | -19 |
| B1 same, 3s, early stop on val | 3,664 | 6,298 | 4,993 | 3,014 | -38 |
| O squared-error, log target | 3,378 | 5,649 | 4,646 | 2,760 | -286 vs B1 |
| O pseudo-Huber, log target (huber_slope 0.15) | 10,282 | 14,608 | 15,936 | 7,520 | invalid: diverged with the default base_score; not retried |
| O sample weight price^0.5 (abs/log) | 3,745 | 6,201 | 4,929 | 3,167 | +81 (worse MAE, better RMSE) |
| O sample weight price^1.0 (abs/log) | 3,875 | 6,219 | 4,943 | 3,353 | +211 |
| T raw price, abs | 3,342 | 5,675 | 4,507 | 2,772 | -322 |
| T raw price, sq | 3,342 | 5,412 | 4,489 | 2,782 | -322 |
| T sqrt price, abs | 3,235 | 5,537 | 4,411 | 2,660 | -429 (hit the 4000-tree cap, still improving) |
| T log(price / cohort_median), abs | 3,787 | 6,422 | 5,124 | 3,134 | +123 |

### Block 2: data and feature ideas, XGB sq/log, 3s (reference D0 = $3,378)

| Experiment | MAE | RMSE | Lux MAE | Non-lux MAE | Delta |
|---|---|---|---|---|---|
| D0 reference | 3,378 | 5,649 | 4,646 | 2,760 | ref |
| D1 train labels = per-VIN median price over all observations | 3,382 | 5,628 | 4,646 | 2,765 | +4 (no gain) |
| D2 drop top 1% train OOF-residual outliers | 3,383 | 5,652 | 4,565 | 2,806 | +5 |
| D2 drop top 3% | 3,441 | 5,825 | 4,646 | 2,853 | +63 |
| D2 drop top 5% | 3,528 | 6,088 | 4,757 | 2,929 | +150 |
| D3 train filter mileage<=250k and price>=5k | 3,398 | 5,655 | 4,624 | 2,799 | +20 |
| D5 + days_listed feature | 3,398 | 5,690 | 4,629 | 2,797 | +20 (and train/score skew) |
| F1 fractional age at last_seen, miles/yr on it | 3,360 | 5,666 | 4,585 | 2,762 | -18 (within noise) |
| F2 + OOF medians (make/model; make/model/trim; make/model/trim/year) | 3,312 | 5,481 | 4,543 | 2,710 | -67 |
| F3 drop zip3, state, exterior_color | 3,535 | 5,827 | 4,796 | 2,919 | +157 (worse) |
| F3b drop zip3 only | 3,482 | 5,868 | 4,785 | 2,845 | +104 (worse) |
| F4 + OOF median by make/model/year/mileage-bin | 3,429 | 5,696 | 4,738 | 2,790 | +51 (worse alone) |
| F5 + kNN comp price (8 nearest by year and mileage, same make/model, OOF) | 3,222 | 5,247 | 4,463 | 2,615 | -157 |
| F6 = F1 + F2 + F4 + F5 together | 3,143 | 5,145 | 4,284 | 2,586 | -235 |
| F6b F6 without zip3/state/color | 3,297 | 5,349 | 4,383 | 2,766 | worse than F6 |
| F7 F6 + dealer_name (one-hot) + dealer listing count | 3,014 | 4,994 | 4,226 | 2,422 | -364 vs D0 |
| F7b F6 + dealer_name one-hot only | 2,991 | 4,958 | 4,172 | 2,414 | -387 |
| F8 F6 + dealer + OOF dealer median price | 2,965 | 4,971 | 4,149 | 2,387 | -413 |

### Block 3: target and weighting on the F6/F7 features (sq objective, 3s)

| Experiment | MAE | RMSE | Lux MAE | Non-lux MAE | Delta |
|---|---|---|---|---|---|
| F6 log target | 3,143 | 5,145 | 4,284 | 2,586 | ref |
| F6 sqrt target | 3,084 | 5,083 | 4,196 | 2,541 | -59 |
| F6 raw target | 3,161 | 5,185 | 4,332 | 2,589 | +18 |
| F7 (+dealer) log target | 3,014 | 4,994 | 4,226 | 2,422 | ref |
| F7 sqrt target | 2,937 | 4,905 | 4,107 | 2,365 | -77 |
| F7 raw target | 3,015 | 5,024 | 4,218 | 2,427 | +1 |
| G1 luxury rows weight x2 (F7 sqrt) | 2,881 | 4,842 | 3,995 | 2,336 | -56 |
| G1 luxury rows weight x3 | 2,860 | 4,868 | 3,988 | 2,309 | -77 |
| G2 separate luxury and non-luxury models | 3,032 | 5,075 | 4,271 | 2,428 | +95 (worse) |
| D4 + 2,908 older rows (>180 days, not in val/test VINs) added to train | 2,667 | 4,574 | 3,799 | 2,114 | -270 |

### Block 4: model families on F7 features, sqrt target (reference = XGB default sq, $2,937)

Single seed except where noted. Val-selected tuning and blend weights both use the val split only.

| Experiment | MAE | RMSE | Lux MAE | Non-lux MAE | Delta |
|---|---|---|---|---|---|
| XGB tuned, 14-config random search, seed 42 | 2,787 | 4,768 | 3,996 | 2,196 | -150, but see below |
| XGB tuned, same params, 3-seed mean | 2,882 | 4,873 | 4,109 | 2,283 | -55, seed sd $74 |
| LightGBM, one-hot matrix | 2,929 | 4,988 | 4,119 | 2,348 | -8 |
| LightGBM, native categoricals | 2,893 | 4,930 | 4,064 | 2,322 | -44 |
| CatBoost RMSE loss, native cats (depth 7, lr 0.06) | 2,924 | 4,920 | 4,087 | 2,356 | -13 |
| CatBoost MAE loss | 3,030 | 5,097 | 4,232 | 2,443 | +93 |
| Random forest | 3,343 | 5,657 | 4,540 | 2,758 | +406 |
| Blend tuned-XGB(3 seeds) + CatBoost, weights 0.5/0.5 chosen on val | 2,777 | 4,715 | 3,933 | 2,212 | -160 |
| Blend tuned-XGB + LightGBM + CatBoost (0.4/0.2/0.4) | 2,766 | n/a | n/a | n/a | -171 (equal weights give 2,768) |
| Blend tuned-XGB + RF | 2,834 | 4,817 | 4,050 | 2,240 | -103 |

### Robustness: three different VIN-grouped splits (`_vin_split` seed 42 / 1 / 2)

One XGB seed each. Baseline = original features, abs/log, early-stopped on val. Final = recommended config.

| Split | Baseline MAE | Final XGB MAE | Final CatBoost | Final blend (with dealer) | Final blend (no dealer) |
|---|---|---|---|---|---|
| 42 | 3,675 | 2,928 | 2,924 | **2,805** (lux 3,958, non-lux 2,241, RMSE 4,721) | 2,934 |
| 1 | 3,950 | 2,866 | 2,919 | **2,790** | 2,937 |
| 2 | 3,639 | 2,726 | 2,772 | **2,653** | 2,768 |

Gain is -24%, -29%, -27% with dealer and -20%, -26%, -24% without it. The no-dealer XGB-only numbers are 3,060 / 3,003 / 2,821.

## Per-idea notes

**Objective: squared error beats absolute error on the log target (-$286).** The pipeline sets `objective="reg:absoluteerror"` (`ml/pipeline.py:430`). XGBoost's absolute-error objective uses a line-search leaf update and converges slowly: at lr 0.05 the early-stopped tree counts were 1,200 to 2,400, and the sqrt+abs run hit the 4,000-tree cap. Squared error converged in 1,000 to 1,500 trees and gave lower MAE and RMSE. The existing median-log-residual calibration at `pipeline.py:552-555` stays valid. Source: XGBoost parameter docs for `reg:squarederror`, `reg:absoluteerror`, `reg:pseudohubererror`: https://xgboost.readthedocs.io/en/stable/parameter.html . Pseudo-Huber failed in my setup (MAE $10k), likely a base_score/initialisation problem with the log target; I did not debug it, so it is untested rather than ruled out.

**Target transform: sqrt slightly beats log; raw is similar to log.** On F7 features sqrt gives $2,937 vs $3,014 log (-2.6%, about 4x seed noise) and raw ties log. Dollar MAE is dominated by expensive cars, so a milder compression than log helps, but it needs the median-offset calibration in sqrt space (done in `lib.py: fit_eval`). Log-ratio-to-cohort-median was worse (+$123): it throws away the information the model already gets from `cohort_median_price` and adds noise when the cohort is sparse. The data has no MSRP field (no `msrp` column in `car_listings`), so MSRP-relative or depreciation targets were not testable. Sources: scikit-learn `TransformedTargetRegressor` https://scikit-learn.org/stable/modules/generated/sklearn.compose.TransformedTargetRegressor.html ; Box and Cox, "An analysis of transformations", J. R. Stat. Soc. B 26(2), 1964 (power-transform family; sqrt is lambda=0.5); Duan, "Smearing estimate: a nonparametric retransformation method", JASA 78(383), 1983, https://doi.org/10.1080/01621459.1983.10478017 (back-transform bias, the reason a calibration offset is needed). Change point: `pipeline.py:367-368` and every `np.expm1` at `:551,:555,:633`, plus `score_listings` (~`:829`).

**Sample weights proportional to price (dollar-MAE alignment): not helpful.** Weighting price^0.5 or price^1 lowered RMSE slightly but raised MAE ($3,745 and $3,875 vs $3,664). Switching objective or target recovered far more than weighting did.

**Comparable-sale kNN feature (F5, -$157).** For each row, the price-weighted mean of the 8 nearest same make/model listings by (model year, mileage/20k), computed out-of-fold on train (5 folds) and from all train rows for val/test/inference. This is the "sales comparison" idea in feature form and lets trees see local price at similar mileage, which the year-level median does not. Implementation in `feats.py: knn_feat`; it would sit next to `_kfold_cohort_encode` (`pipeline.py:280`). At inference it needs the training listings available (the saved payload would need to carry a compact comp table, like `cohort_stats` does now at `pipeline.py:670`). Neighbour weights `1/(dist+0.5)` and k=8 were not tuned. Sources: scikit-learn `KNeighborsRegressor` https://scikit-learn.org/stable/modules/generated/sklearn.neighbors.KNeighborsRegressor.html ; Cover and Hart, "Nearest neighbor pattern classification", IEEE Trans. Inf. Theory 13(1), 1967.

**Hierarchical OOF cohort medians (F2, -$67; F6 combined -$235).** Adds out-of-fold medians at make/model, make/model/trim and make/model/trim/year. This is target encoding with k-fold leakage control, same technique as `_kfold_cohort_encode` extended to more keys. The mileage-bin cohort (F4) hurt alone (+$51, buckets get too sparse) but F6 with it did better than without, so I kept it, though its marginal value is unproven. Sources: Micci-Barreca, "A preprocessing scheme for high-cardinality categorical attributes in classification and prediction problems", ACM SIGKDD Explorations 3(1), 2001, https://doi.org/10.1145/507533.507538 ; scikit-learn `TargetEncoder` (cross-fitted, built for this) https://scikit-learn.org/stable/modules/generated/sklearn.preprocessing.TargetEncoder.html . Change point: `pipeline.py:254-309`, feature lists `:373-385`, and `ListingRepository.get_cohort_stats` in `db/repository.py:120` for the inference-time stats.

**Dealer name (F7/F7b/F8, about -$150 to -$200 on top of F6).** `dealer_name` is not currently a feature (`_build_features_raw`, `pipeline.py:173-251`). One-hot with 214 levels (12,519 pooled rows) worked, an OOF dealer median price added a bit more (F8 $2,965). Zip3 turned out to matter more than its permutation importance suggested: dropping zip3, state and color cost +$157 (F3), consistent with zip3 acting as a dealer/region proxy. See the caveat in the summary on deal-score quality. Also `dealer_rating`, `accident_count` and `owner_count` are all constant/NULL in the DB and `condition` is always `used`, so they carry no signal today.

**Age at listing date (F1, -$18).** Replacing `now_year - year` (`pipeline.py:178-191`) with `(last_seen decimal year) - year` removes drift between train and serve and gave a small, noise-level gain; I would still adopt it for correctness since `utcnow().year` makes ages jump on 1 January. Not a standalone accuracy lever.

**Data cleaning: little to gain.** Repeated VINs are already collapsed to the latest row by `training_pool_v` (`db/models.py:92-107`). Replacing the label by the per-VIN median across all observations changed 2,032 labels and moved MAE by +$4, so price-drift noise is not the issue. Dropping train rows by out-of-fold residual (the high-error rows) made things worse at 3% and 5%, because test rows contain the same hard cars. Tighter filters (mileage<=250k, price>=5k) were +$20. Conclusion: leave cleaning alone. `days_listed` as a feature was +$20 and would be a train/serve mismatch (a new listing has small days_listed), so avoid it.

**More history in training (D4, -$270).** `TRAINING_WINDOW_DAYS = 180` (`db/models.py:77`, used in `training_listings_v` at `:108-111`). Adding the 2,908 pool rows older than 180 days (excluding any VIN in val/test) improved XGB to $2,667, with luxury -$308 and non-luxury -$251. More data helps this small-sample model more than the staleness hurts on a recent test set. Caution: the test set is recent, and older prices reflect an older market; I did not test whether the gain survives a time-forward split, and the cohort/kNN features would then mix older prices into recent comps. A moderate widening (for example 270 days) or a recency sample weight is a safer first step.

**Luxury weak spot.** Luxury MAE fell from $5,054 to $3,958 with the recommended blend (-22%, a similar percentage to non-luxury -26%), so luxury remains about 1.8x non-luxury in dollars, mostly because the price level is higher. Upweighting luxury rows 3x gave luxury -$118 and non-luxury -$56 at the XGB level, a small but consistent gain (not combined into the recommended number). A separate luxury model did worse (+$95) because it halves the training data.

**Model families.** Tuned XGB looked best on one seed (val $2,693, test $2,787) but the 3-seed mean was $2,882 with a $74 standard deviation, so most of that single-seed gain is seed luck; the winning config was depth 4, colsample 0.3, and reached the 4,000-tree cap. CatBoost with native categoricals (ordered target statistics) and LightGBM landed at about $2,900 each, similar to default XGB; their value is diversity in a blend (50/50 XGB+CatBoost -$123 on seed 42, and better than XGB alone on all three splits). CatBoost's MAE loss was worse than RMSE loss, consistent with the XGB finding. RF is worse than boosting here and adds little in a blend. Sources: XGBoost, Chen and Guestrin, KDD 2016, https://arxiv.org/abs/1603.02754 ; LightGBM, Ke et al., NeurIPS 2017, https://papers.nips.cc/paper/2017/hash/6449f44a102fde848669bdd9eb6b76fa-Abstract.html and categorical-feature docs https://lightgbm.readthedocs.io/en/stable/Advanced-Topics.html ; CatBoost ordered target statistics, Prokhorenkova et al., NeurIPS 2018, https://arxiv.org/abs/1706.09516 and docs https://catboost.ai/docs/en/concepts/algorithm-main-stages_cat-to-numberic ; CatBoost regression losses https://catboost.ai/docs/en/concepts/loss-functions-regression . Change point: add candidates at `pipeline.py:407-416` and `:491`; production would need `catboost` added to requirements.

## Ideas researched but not tested

- **MSRP-relative or depreciation target:** no MSRP field in `car_listings`; would need a VIN-decode (NHTSA vPIC) or Marketcheck specs join. Likely valuable for luxury, where trim/option content drives price.
- **Native categorical support in XGBoost** (`enable_categorical`, https://xgboost.readthedocs.io/en/stable/tutorials/categorical.html): not tested separately; LightGBM and CatBoost native categoricals gave only small gains over one-hot, so I expect little.
- **Stacking with a meta-learner** (scikit-learn `StackingRegressor` https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.StackingRegressor.html ; Wolpert, "Stacked generalization", Neural Networks 5(2), 1992): simple val-weighted blends were used instead; with 1,540 val rows a fitted meta-model risks overfitting.
- **Quantile/conformal intervals** for deal-score confidence: out of scope for accuracy.
- **Time-forward evaluation** (train on older, test on newest): needed to validate D4 and the cohort features against market drift; not run (the task fixed a VIN-grouped split). Scikit-learn `GroupKFold` (https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupKFold.html) is the right tool for grouped CV if the test set is ever made larger.
- **Options/package text features from trim string** (tokenised trim keywords): `trim_rank` already captures part of this; not tested.
- **Full hyperparameter sweep, neural nets, TabPFN-style models:** skipped by constraint and because the tuned-XGB result above shows tuning gains are comparable to seed noise at this data size.

## Implementation checklist (suggested order, file:line)

1. `ml/pipeline.py:430` change objective to `reg:squarederror` (and drop `eval_metric="mae"` coupling at `:477` if desired; early stopping still works on MAE). Re-run grid at `:442-456`. Expected: about -$280.
2. `ml/pipeline.py:367-368`, `:551`, `:555`, `:633` and `score_listings` (~`:829`): switch target to sqrt (`np.sqrt` / square) with the median offset in sqrt space. Expected: about -$75.
3. `ml/pipeline.py:173-251` (`_build_features_raw`): add `dealer` (lowercased `dealer_name`), `dealer_n`, `age_frac`, `mpy_frac`; add them to `numeric_features`/`categorical_features` (`:373-385`).
4. `ml/pipeline.py:254-309` and `db/repository.py:120`: add OOF medians for make/model, make/model/trim, make/model/trim/year, make/model/year/mileage-bin; add `knn_price` (see `feats.py`) and persist what inference needs in the payload (`:664-672`).
5. `ml/pipeline.py:407-416,:491`: add a CatBoost candidate and a 50/50 XGB+CatBoost blend candidate chosen on val like the others (`:609`).
6. Optional: `db/models.py:77` raise `TRAINING_WINDOW_DAYS`; luxury sample weight 2 to 3 in `.fit(...)`.

## How to reproduce

Scratch dir: `/private/tmp/claude-501/-Users-danielpark-car-intel/e122527d-2570-4e9e-aa31-655ba86a53f3/scratchpad/research/` (call it `$R`). It holds a copy of `car_intel.db`, a copy of `config/`, and a separate venv `$R/v2` (lightgbm, catboost, xgboost, scikit-learn; the repo venv was not modified). Every run logs one JSON line per experiment to `$R/results.jsonl` (note: for rows written by `e4.py`/`e5.py` the `name` of CatBoost and blend rows is blank or generic because of a logging quirk; use the table above, which was assembled from the console output in order).

```
cd $R
export PYTHONPATH=/Users/danielpark/car-intel
PY=/Users/danielpark/car-intel/venv/bin/python
$PY baseline.py          # runs ml.pipeline.train on the copy -> $3,702.0 MAE, matches production log
$PY e0.py                # hand-written replica -> $3,702.04, prints xgb lr=0.05, n=822
$PY e1.py                # Block 1: objectives and targets (about 25 min; abs-error runs are slow)
$PY e2.py                # Block 2: data and feature ideas, writes feat.pkl
$PY e3.py                # dealer features and target on F6, writes feat7.pkl
./v2/bin/python e4.py    # Block 4: tuned XGB, LightGBM, CatBoost, RF, blends (needs bestxgb.pkl or the search block)
./v2/bin/python e5.py 42 1 2   # Robustness: baseline vs final config on three splits, with and without dealer
./v2/bin/python e6.py    # luxury weights, separate luxury model, older-data augmentation
```

Shared code: `common.py` (loads `training_pool_v` from the copy as `scripts/holdout_audit.py` does), `lib.py` (split, cohort encoding, `fit_eval`, `multi`), `feats.py` (final feature builder, kNN feature). `e4.py` was edited between runs: the random-search block is replaced by loading `bestxgb.pkl` (best params: max_depth 4, min_child_weight 1, colsample_bytree 0.3, subsample 0.9, reg_lambda 3, reg_alpha 0.05).

Limits of this study: one fixed test set of 1,923 rows (about 4% sampling error on a $3k MAE); gains under about $50 are not distinguishable from seed noise; val-set model selection and blend weights add a small optimistic bias to the "tuned" and blend rows; feature ladders were stacked greedily, so the single-change deltas are not strictly additive; time-forward drift was not tested.
