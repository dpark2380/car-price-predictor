# Held-out accuracy audit, 2026-11-24

**Method.** Retrained from scratch in memory (`ml.pipeline.train(model_path=None)`, nothing saved; `models/` untouched, md5 verified) on `training_pool_v`, 23,775 cars (one row per VIN), data as of 2026-11-22. The saved model is not evaluated: it was trained on an earlier snapshot and the script cannot show which of today's VINs it saw. Split is grouped by VIN (64/16/20: 15,216 / 3,804 / 4,755 cars), asserted disjoint. Selection and calibration use val only; every number below is on the 4,755 test cars. Cohort and comparables features come from train-split cars of other dealers only. Selected model: blend (XGBoost under $10k, mean of XGBoost/CatBoost/LightGBM above), val MAE $2,782. Bootstrap: 2,000 resamples, seed 42, percentile 95% CI. Throwaway script: scratchpad `audit.py` (the repo's `scripts/holdout_audit.py` only reports the older xgb vs rf comparison).

**Headline (blend, n = 4,755):** median absolute % error **7.7%** (95% CI 7.3 to 8.0), signed median -0.07%, MAE $2,743, within 5% / 10% / 20%: 36.2% / 59.2% / 83.6%.

| Slice | n | Median APE % (95% CI) | Signed median % | MAE $ | <=5% | <=10% | <=20% |
|---|---|---|---|---|---|---|---|
| All | 4,755 | 7.71 (7.34-7.99) | -0.07 | 2,743 | 36.2 | 59.2 | 83.6 |
| <$10k | 572 | 15.39 (13.97-17.20) | +9.64 | 1,503 | 17.1 | 33.0 | 60.7 |
| $10-20k | 1,352 | 9.62 (8.91-10.33) | +1.04 | 1,973 | 29.1 | 51.6 | 77.8 |
| $20-35k | 1,675 | 5.59 (5.27-5.85) | -0.23 | 2,247 | 45.9 | 69.8 | 91.6 |
| $35-60k | 901 | 6.62 (6.00-7.15) | -2.29 | 4,006 | 40.1 | 66.3 | 90.8 |
| >$60k | 255 | 7.54 (6.29-8.58) | -4.19 | 8,413 | 38.4 | 63.1 | 87.5 |
| 0 comparables | 530 | 15.66 (13.86-17.10) | +1.31 | 4,726 | 18.1 | 34.2 | 61.7 |
| 1-2 | 825 | 9.31 (8.53-9.98) | -0.79 | 2,720 | 28.4 | 53.3 | 78.5 |
| 3-9 | 1,604 | 7.22 (6.55-7.89) | -0.28 | 2,342 | 38.7 | 60.2 | 85.9 |
| 10-29 | 1,177 | 6.15 (5.67-6.57) | +0.62 | 2,477 | 43.2 | 67.6 | 90.1 |
| 30+ | 619 | 6.08 (5.69-6.72) | -0.44 | 2,625 | 42.2 | 69.6 | 90.6 |

Bands use the true listed price; comparables = other-dealer cars of the same make/model/year in the train split. Signed error is (pred - true)/true: positive means over-predicting (cars under $10k are over-predicted by about 10%).

**Caveats.** Asking prices, not sale prices. Random VIN split over the same months, so not a forecasting test (time-forward would be worse). Seven western states only; do not generalise nationally. Model is selected on val and the same split seed is used each run, so figures move a little with each DB snapshot. The older audit (8.2%, n=1,921) used a different model and data, so the two are not like-for-like.
