# Price model: improving accuracy without new data and without overfitting

Run date 2026-10-13. Scope: use only columns already stored in `car_listings` (`db/models.py:12-43`) or already mapped by `map_listing` (`scraper/data_ingest.py:162-212`). No Marketcheck calls, no changes to the repo except this file. Builds on `model_research.md` (2026-10-09), which I read first and do not repeat.

Experiments ran on a copy of `car_intel.db` (training_pool_v with the 180-day window, 9,317 rows, VIN split 5962/1491/1864, identical to the 2026-10-12 production log row at `logs/training_log.csv`). Reference model "ref" = repo features and cohort encoding, XGBoost `reg:squarederror` on `log1p(price)`, lr 0.05, early stopping on val, median-log-residual calibration on val. It scores test MAE $3,342 on split 42 (seed sd about $19, from seeds 0/1/2: 3,342 / 3,336 / 3,306). Treat any delta under about $50 as noise. Scripts are in the scratchpad `x/` folder (`lib.py`, `e1.py` to `e4.py`).

## Summary: the product goal changes what matters

The earlier study optimised dollar MAE on a random VIN holdout. The product is a deal score: listing price vs predicted price, scaled by the model's typical % error per price segment (`ml/pipeline.py:738-790`). Three measurements below show that the biggest weaknesses are not in MAE:

1. **Most listings are scored in-sample.** `get_scoring_listings_df` (`db/repository.py:153-177`) scores every listing seen in the last 180 days, and 64% of those are rows the model trained on (`pipeline.py:361-364`, `:830-835`). Measured: on train rows the model's median abs % error is 5.7% vs 8.5% on held-out rows, and 4.2% of train rows get 4 or 5 stars vs 10.4% of held-out rows (5 stars: 0.4% vs 3.4%). Deals are systematically hidden for the cars the model has memorised.
2. **One error yardstick per price band is wrong for thin cohorts.** Held-out false-flag rate (>= 4 stars under the current yardstick) is 14.9% for cohorts with fewer than 3 training rows, 9.1% for 3-9, 5.2% for 10-29 and 2.0% for 30+. The standard deviation of the z-score is 3.7 / 2.5 / 1.35 / 0.97 across those bins.
3. **The VIN holdout is optimistic about dealers.** Holding out whole dealers instead of VINs raises MAE from $3,432 to $4,463 and median % error from 8.5% to 11.8% (3 splits). The model leans on dealer-correlated signals (zip3, trim, colour, same-lot cohort siblings). Because real deal-hunting looks at listings from dealers with sibling cars in the training set, the VIN split is not wrong, but it hides how much of the accuracy is "dealer pricing habit".

### Ranked table

| Rank | Idea | Expected gain | Evidence | Overfit / leakage risk | Effort |
|---|---|---|---|---|---|
| 1 | Score with cross-fitted (never-saw-this-VIN) predictions | Deal-score fairness: 4-star flag rate for in-sample rows 4.2% -> about 10%; no MAE change | Measured (A) | Low; removes an existing leak | Medium |
| 2 | Cohort-aware error yardstick (Mondrian bins by cohort_count x price band) | Flat false-flag rate across thin and thick cohorts; no MAE change | Measured (A2), sd(z) 3.7/2.5/1.35 -> 2.2/2.6/2.1 | Low if bins come from val or OOF | Low |
| 3 | Seed bagging of XGB (5 seeds) | MAE -$48 mean over 3 splits (3,432 -> 3,384); <$10k median % error 17.0 -> 16.6 | Measured | Very low | Low |
| 4 | Leave-one-dealer-out (LODO) cohort and comp features | MAE neutral (-$6/-$30/-$28 on VIN splits); removes own-dealer markup from comps, which is what deal detection wants | Measured | Low; the safe way to keep comps without learning a dealer's own markup | Medium |
| 5 | Pick the target and objective with relative-error metrics, not only dollar MAE | sqrt target: MAE -$141 (3,432 -> 3,291) but <$10k median % error 17.0 -> 18.0 (worse). Do not adopt sqrt blindly | Measured | Low | Low |
| 6 | Dealer-grouped and time-forward validation as extra gates for every change | Honest estimate; stops dealer-proxy gains looking like accuracy | Measured (B, E) | Reduces risk | Low |
| 7 | Tokenised trim keywords (top 60 words) | MAE -$51 mean (-6/-21/-126 by split), weak | Measured | Low | Low |
| 8 | Moderately wider training window plus recency weights | Unproven; earlier study saw -$270 for all older rows | Not tested here | Medium (market drift) | Low |
| 9 | Nested/repeated CV for tuning instead of one val split | Honest selection; removes val-reuse bias | Literature | Reduces risk | Medium |

Measured and rejected (no gain beyond noise, listed so nobody retries them): unsupervised label-free features (mileage vs cohort median, years behind newest model year, model-year count; +$21), OOF smoothed zip3 residual encoding added (+$15) or replacing zip3 one-hot (+$43), one-hot min_frequency=10 pooling (+$17), monotone constraint on mileage (+$13), and the combination of several of these (+$61, worse).

## Experiment results

All numbers: test set, three VIN-grouped splits (`_vin_split` seeds 42/1/2), one XGB seed each unless noted. Seed noise about $19 sd on one split (about $11 on a 3-split mean).

| Config | MAE s42 | MAE s1 | MAE s2 | Mean MAE | Delta vs ref | <$10k median % err (mean) |
|---|---|---|---|---|---|---|
| ref (sq, log) | 3,342 | 3,461 | 3,494 | 3,432 | ref | 17.0 |
| sqrt target | 3,225 | 3,260 | 3,388 | 3,291 | -141 | 18.0 |
| bag 5 seeds | 3,308 | 3,414 | 3,431 | 3,384 | -48 | 16.6 |
| trim tokens | 3,336 | 3,440 | 3,368 | 3,381 | -51 | 17.2 |
| depth 4, colsample 0.3, mcw 5 | 3,320 | n/a | n/a | n/a | -22 (one split) | n/a |
| unsupervised mileage/generation feats | 3,364 | 3,511 | 3,486 | 3,454 | +21 | n/a |
| zip3 OOF residual encoding added | 3,320 | 3,498 | 3,525 | 3,447 | +15 | n/a |
| zip3 encoding replacing zip3 one-hot | 3,395 | 3,568 | 3,463 | 3,475 | +43 | n/a |
| one-hot min_frequency 10 | 3,349 | 3,497 | 3,502 | 3,450 | +17 | n/a |
| monotone mileage | 3,349 | 3,493 | 3,494 | 3,446 | +13 | n/a |
| unsup + trim + zip enc + min_freq | 3,402 | 3,596 | 3,482 | 3,493 | +61 | n/a |

Validation-design experiments (ref model):

| Check | Result |
|---|---|
| Random VIN split, 3 splits | MAE $3,432, median % err 8.5% |
| Dealer-grouped split, 3 splits (`GroupShuffleSplit` on dealer name) | MAE $4,544 / $5,135 / $3,710 (mean $4,463), median % err 11.4-12.1%. Test sizes vary (1,170-1,923) because big dealers land in one side |
| Time-forward (train oldest 64% by `last_seen`, test newest 20%, test window 2026-10-05 to 10-12) | MAE $3,214 (2 seeds), no drift penalty vs random. Caveat: the newest `last_seen` rows are mostly still-active listings and the window is one week |
| LODO cohort vs base, VIN split | MAE 3,336 vs 3,342; 3,431 vs 3,461; 3,466 vs 3,494 |
| LODO cohort vs base, dealer-grouped split | MAE 4,635 vs 4,678; 4,415 vs 4,325; 4,849 vs 4,855 (mean -$14, mixed signs; neutral) |

Deal-flag measurements (split 42, ref model, val-derived segment yardstick, cutoffs z >= 1.875 for 4 stars and z >= 3 for 5 stars as in `pipeline.py:768-790`):

| Rows | n | Median % err | 4+ star rate | 5 star rate | "Overpriced" (z <= -1.875) |
|---|---|---|---|---|---|
| Train rows, scored as production does (full-train cohort stats, own price included) | 5,962 | 5.7% | 4.2% | 0.4% | 7.6% |
| Held-out test rows | 1,864 | 8.5% | 10.4% | 3.4% | 15.5% |

Held-out flag rate by cohort_count at inference (segment-only yardstick -> segment x cohort-bin yardstick):

| cohort_count | n | 4+ star, segment only | 4+ star, Mondrian | sd(z), segment only | sd(z), Mondrian |
|---|---|---|---|---|---|
| < 3 | 867 | 14.9% | 9.5% | 3.67 | 2.20 |
| 3-9 | 506 | 9.1% | 9.7% | 2.48 | 2.63 |
| 10+ | 491 | 3.9% | 15.5% | 1.21 | 2.12 |

(Mondrian bins here come from only 1,491 val rows, so the 10+ bin yardstick is noisy and overshoots. It shows direction, not a tuned number.)

## Per-idea sections

### 1. Cross-fitted scoring (rank 1)

**What.** At training time, also fit K models (K = 5, folds grouped by VIN, e.g. `GroupKFold`) on the training pool and store each listing's out-of-fold prediction. Score a listing in the pool with its OOF prediction (or the mean of the fold models that excluded it). New listings that no model saw use the final model. Cohort stats for the OOF predictions must also exclude the row's own fold, exactly as `_kfold_cohort_encode` does for training (`pipeline.py:280-309`), otherwise a listing's own price is in its comparison group.

**Why.** Today `score_listings` runs the final model on every listing (`pipeline.py:830-835`), including training rows, with cohort stats that contain the row's own price (`:361`, `:833`). Measured: 35% of training rows have cohort_count <= 2 including themselves, so for them cohort_median_price is nearly their own price. In-sample predictions are closer to the listed price, so fewer deals and fewer overpriced listings are flagged (table above). In-sample median % error is 0.67 of the held-out value (5.7% vs 8.5%), yet the yardstick comes from held-out val.

**Validate.** The deliverable is flag-rate parity, not MAE: the 4+/5 star rate on pool rows scored via OOF should match held-out rows (about 10% / 3%) within sampling error. Check with several split seeds. MAE on a held-out test set is unaffected because test rows are already unseen.

**Risk.** Low. Costs K extra fits per run (about 12 s each here). It also changes the stored predictions for old listings, so the score distribution shifts once; note this when rolling out.

**Sources.** scikit-learn `cross_val_predict` (out-of-fold predictions): https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.cross_val_predict.html ; `GroupKFold`: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupKFold.html ; cross-fitting for leakage control in encodings, Micci-Barreca 2001, https://doi.org/10.1145/507533.507538 ; evaluating on data the model never saw, Roberts et al., Ecography 40(8), 2017, https://doi.org/10.1111/ecog.02881 .

### 2. Cohort-aware error yardstick (rank 2)

**What.** `_segment_errors` (`pipeline.py:749-758`) returns one median abs % error per price band. Replace by a table over (price band x cohort_count bin: 0-2, 3-9, 10+), with the fallback to the band's overall value when a cell has fewer than about 30 rows (the same `min_n` rule already in the function). Better still, estimate cell errors from out-of-fold residuals on train+val (about 7,400 rows) rather than val alone, so the cells are not noisy. Scoring then needs `cohort_count` at the point of use (already computed at `:833`).

**Why.** The false-flag rate depends strongly on cohort size (14.9% to 2.0% above). Under the present yardstick a rare car with an unusual listing price looks like a bargain too easily, while a common car almost never reaches 4 stars. This is a deal-detection fix with no cost in MAE.

**Validate.** Report the 4+ star rate and sd(z) by cohort bin on held-out rows with cell errors estimated on a disjoint fold (not the rows being flagged). Repeat over 3 split seeds. Aim for flat rates, not a lower rate.

**Risk.** Low. The over-fitting danger is small cells; pool OOF residuals and keep `min_n`. Conformal theory justifies binning the calibration set by a covariate ("Mondrian" conformal) to get validity within bins.

**Sources.** Mondrian/conditional validity: Vovk, "Conditional validity of inductive conformal predictors", https://arxiv.org/abs/1209.2673 ; split conformal for regression: Lei et al., "Distribution-free predictive inference for regression", JASA 2018, https://arxiv.org/abs/1604.04173 ; overview: Angelopoulos and Bates, https://arxiv.org/abs/2107.07511 .

### 3. Seed bagging (rank 3)

**What.** Train the chosen XGB with 5 different `random_state` values (subsample and colsample make them differ) and average the log predictions before calibration. Measured MAE -$48 over 3 splits (each split improved: -34/-47/-63), median % error under $10k 17.0% -> 16.6%.

**Why.** It reduces variance, which matters at 6k rows. The earlier study found a $74 seed sd for its tuned config; averaging seeds is the cheap fix.

**Validate.** Compare against the single-seed reference over several split seeds with paired differences; do not choose the number of seeds on the test set (5 is plenty).

**Risk.** Very low, no new information enters the model. Cost 5x fit time at the final step only (grid search and early stopping stay single-seed), and model file 5x larger.

**Sources.** Breiman, "Bagging predictors", Machine Learning 24, 1996, https://doi.org/10.1007/BF00058655 ; XGBoost `subsample` and `colsample_bytree` introduce the randomness: https://xgboost.readthedocs.io/en/stable/parameter.html .

### 4. Leave-one-dealer-out comps and cohort stats (rank 4)

**What.** When computing `cohort_median_price`, `cohort_count` (and the earlier study's kNN comp feature and OOF medians, if adopted), build each row's comparison group from listings of other dealers only. For training rows this replaces the 5-fold OOF split with leave-one-dealer-out (about 220 dealers, one groupby each, feasible); for val/test/scoring, drop the row's own dealer from the stats. Measured (E4): MAE is unchanged (VIN split -$6/-$30/-$28; dealer-grouped -$43/+$90/-$6).

**Why.** A fleet dealer such as Hertz San Diego (1,518 of 12,971 pool rows, counted in `training_pool_v`) sets a price that its own sibling cars then reuse as their "market median". A comp built from the same lot partly measures that dealer's markup, so a listing from that dealer scores as fair no matter how it is priced. This keeps the useful comparison signal without learning "who is selling". It also fixes a quiet version of the leak the earlier kNN recommendation would have: a kNN comp built from all train rows includes the scored car's own lot (and itself, at distance 0, for in-train rows).

**Validate.** Gate on the dealer-grouped split as well as the VIN split (see idea 6). Accept if the dealer-grouped MAE does not rise and the VIN MAE does not rise by more than seed noise. For deal quality, check that flag rates for the largest dealers are not far from the overall rate (a dealer with 1,000+ cars at a 3% 4-star rate versus 10% overall indicates the dealer is still leaking into the score).

**Risk.** Low for leakage; removes a leak. Cost: for tiny cohorts that exist only at one dealer the comp is empty (NaN, imputed). The inference payload needs the training table keyed by dealer, not just `cohort_stats`.

**Sources.** Target encoding must not see the row's own information, Micci-Barreca 2001, https://doi.org/10.1145/507533.507538 ; scikit-learn's `TargetEncoder` cross-fits for the same reason: https://scikit-learn.org/stable/modules/generated/sklearn.preprocessing.TargetEncoder.html ; grouped evaluation when observations cluster, Roberts et al. 2017, https://doi.org/10.1111/ecog.02881 ; `GroupKFold`/`LeaveOneGroupOut`: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.LeaveOneGroupOut.html .

### 5. Choose target and objective by relative-error metrics (rank 5)

**What.** The deal score is a percent gap (`_deal_score_from_prices`, `pipeline.py:788`) judged against median abs % error per band, yet candidate selection uses dollar MAE on val (`:551`, `:609`) and the earlier study ranks by dollar MAE. Dollar MAE favours expensive cars. Measured: the sqrt target cuts MAE $141 but the under-$10k median % error (the band the user cares about, 16-22% in the production log) gets worse on 2 of 3 splits (17.6 -> 17.5, 18.0 -> 19.9, 15.4 -> 16.7). The log target with squared error is the natural relative-error fit.

**Recommendation.** Keep log as the default. Select on a relative metric, for example median abs % error per band averaged over the five bands, or mean absolute log error (the log accuracy ratio). If a dollar-optimal model is wanted for display, blend: for a listing, use a weight between the sqrt and log predictions chosen on the OOF set. Do not adopt the earlier study's sqrt recommendation without this check.

**Validate.** Report, per change, MAE and the five per-band median % errors, over three splits. Accept only if no band's median % error worsens beyond about 1 point.

**Risk.** Low. The danger is the reverse: shipping a lower-MAE model that scores cheap cars worse.

**Sources.** Squared error on log targets and the cost of back-transforming: Duan, JASA 78(383), 1983, https://doi.org/10.1080/01621459.1983.10478017 ; relative-error accuracy measures and log accuracy ratio: Tofallis, J. Oper. Res. Soc. 66(8), 2015, https://doi.org/10.1057/jors.2014.103 ; match loss to the reported functional (MAE <-> median, squared error <-> mean): Gneiting, "Making and evaluating point forecasts", JASA 2011, https://arxiv.org/abs/0912.0902 ; XGBoost objectives: https://xgboost.readthedocs.io/en/stable/parameter.html .

### 6. Validation gates: dealer-grouped, time-forward, repeated splits (rank 6)

**What.** Add three cheap checks next to `_vin_split` (`pipeline.py:318-329`) and `scripts/holdout_audit.py`: (a) the same train/val/test split but grouped by dealer; (b) newest-20%-by-`last_seen` as test; (c) 3 to 5 split seeds with paired differences. Report mean and spread, not one split. The test set of 1,864 rows gives about 4% sampling error on a $3k MAE, comparable to most gains here.

**Why.** Measured: dealer-grouped MAE is 30% higher than VIN-grouped. A feature that "improves" the VIN split but not the dealer-grouped split is probably learning dealer habit (see the dealer warning below). The time-forward test (MAE $3,214) shows no drift penalty over a week, but that test is weak: the newest rows are mostly active listings, and one week is short. Rerun it as the DB grows and when testing wider training windows.

**Risk.** None added; these only reduce optimism. The dealer-grouped split removes whole large dealers, so test sizes and mixes change per seed.

**Sources.** `GroupKFold` / `GroupShuffleSplit` https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupShuffleSplit.html ; `TimeSeriesSplit` https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html ; Roberts et al. 2017, https://doi.org/10.1111/ecog.02881 .

### 7. Tokenised trim keywords (rank 7)

**What.** Binary features for words that occur at least 40 times in train `trim` strings (60 kept, e.g. awd, 4wd, hybrid, premium, limited), plus a `trim_missing` flag (130 of 12,971 pool rows have no trim). Measured -$51 mean MAE with the same sign on all three splits (-6/-21/-126); <$10k median % error 17.2 vs 17.0, so no help for cheap cars.

**Validate.** Vocabulary must be built from train rows only (done here); check the dealer-grouped split too. **Risk.** Low but the gain is within about 2x of noise, so treat it as optional. Fixed vocabulary must be saved with the model.

**Sources.** XGBoost handles sparse binary columns natively, https://xgboost.readthedocs.io/en/stable/parameter.html ; `OneHotEncoder` `min_frequency` for rare-token pooling: https://scikit-learn.org/stable/modules/generated/sklearn.preprocessing.OneHotEncoder.html .

### 8. Wider training window plus recency weights (rank 8)

**What.** `TRAINING_WINDOW_DAYS = 180` (`db/models.py:77`). The earlier study found -$270 by adding all older pool rows. The DB starts 2026-03-23, so the full pool is about 12,971 rows vs 9,317 in window. Try 270 days, or all rows with weights like `0.5 ** (age_days / 120)`. Time-forward result above hints that drift is small at weekly scale, but cohort and comp features then mix older prices into current comps.

**Validate.** Time-forward split (test = newest weeks, train strictly earlier) comparing windows 120/180/270/all, using the same test rows each time; plus the dealer-grouped gate. Choose the window by nested CV or a separate validation period, not the test. **Risk.** Medium: market drift (used-car prices move), and the rows older than 180 days are mostly delisted cars whose last asking price is stale. Not tested here.

**Sources.** `TimeSeriesSplit` https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html ; `sample_weight` in XGBoost `fit`: https://xgboost.readthedocs.io/en/stable/python/python_api.html#xgboost.XGBRegressor.fit .

### 9. Nested or repeated CV for tuning (rank 9)

**What.** Today selection and calibration reuse one val split of 1,491 rows (`pipeline.py:547-552`, `:609`), and the grid search at `:442-456` uses 5-fold on train with an absolute-error objective. With 4 candidates the bias is small, but any larger search (the earlier study's 14-config search gained $150 on one seed and $55 over three) will pick seed luck. Use repeated grouped K-fold on train+val for tuning and keep the test split for reporting only; for a big search use nested CV.

**Validate.** The tuned config must beat the default on outer folds not used to pick it. **Risk.** Reduces overfitting; costs compute. Use random search with a small budget.

**Sources.** Cawley and Talbot, "On over-fitting in model selection and subsequent selection bias in performance evaluation", JMLR 11, 2010, https://jmlr.org/papers/v11/cawley10a.html ; Bergstra and Bengio, "Random search for hyper-parameter optimization", JMLR 13, 2012, https://jmlr.org/papers/v13/bergstra12a.html .

## Dealer warning: features that lower MAE but hurt deal detection

- **`dealer_name` as a feature** (earlier study F7, -$150 to -$200): the model learns that dealer's price level. A habitually overpriced lot is predicted high, so its listings score as fair. Accept only if you want a fair-price estimate, not deal detection. Dealer-grouped validation will show its gain disappears for unseen dealers.
- **OOF dealer median price** (F8): same problem, stronger.
- **`dealer_n` / dealer listing count:** a proxy for dealer identity (Hertz San Diego alone has 1,518 rows).
- **zip3 / state / colour one-hots:** dropping them cost $104-$157 in the earlier study because they act as dealer and region proxies. Region is a legitimate price driver, so keep them, but note the dealer-grouped gap above and prefer LODO comps (idea 4) to keep the signal without the markup.
- **kNN comps and cohort medians built from all training rows:** include the scored car's own lot, and for in-train rows the car itself. Use LODO (idea 4) and exclude self by VIN.
- **A dealer-neutral alternative (untested):** train with dealer included so it absorbs markup noise (partial pooling), then score with dealer averaged out (average the predictions over a sample of dealers, partial-dependence style). Gate: dealer-grouped holdout MAE must be no worse than the dealer-free model, and big-dealer flag rates should look like everyone else's. Shrink dealer effects toward zero with empirical-Bayes weights so small dealers do not dominate. Sources: Efron and Morris, JASA 68(341), 1973, https://doi.org/10.1080/01621459.1973.10481350 ; Friedman, "Greedy function approximation", Annals of Statistics 29(5), 2001, https://doi.org/10.1214/aos/1013203451 (partial dependence).

## Revisiting `model_research.md`'s recommendations

| Recommendation | Uses only existing data? | Overfit / leakage assessment | Deal-score effect | My verdict |
|---|---|---|---|---|
| Squared error instead of absolute error (-$286) | Yes | Safe; the XGBoost objective only. My ref uses it; the gap to the production number is reproducible (production log $3,700-3,890 vs my ref $3,342 on the same-size data). Pseudo-Huber failure in their run is likely the log-target/base_score issue, untested | Neutral | Adopt. Check median % error per band as well as MAE |
| Sqrt target (-$77 to -$141) | Yes | Safe | Likely worse for cheap cars: measured <$10k median % error +1.0 point on average | Do not adopt as the sole target; see idea 5 |
| kNN comparable-sales feature (-$157) | Yes (training rows kept in the payload) | The 5-fold OOF is right for training rows, but (1) at scoring an in-train row's own record is in its neighbours (distance 0), (2) same-lot siblings are neighbours, which makes OOF features look better than they will for a fresh listing, (3) k and weights untuned | Contaminated by dealer markup unless built leave-one-dealer-out and excluding self | Adopt only with self- and same-dealer exclusion, validated on the dealer-grouped split |
| Hierarchical OOF medians (-$67) | Yes | Right technique. Sparse cells (make/model/trim/year) need shrinkage toward the parent (empirical-Bayes weight n/(n+k)); not present in their version. Their F4 mileage-bin cohort hurt alone | Same self/dealer issues as kNN | Adopt with shrinkage and LODO; drop the mileage-bin cohort |
| `dealer_name` one-hot + dealer count (-$152 to -$200) | Yes | MAE gain is real on a VIN split, but it is memorising dealers; the dealer-grouped holdout will not show it | Harmful (learns a dealer's own markup) | Do not adopt for the deal score |
| CatBoost/XGB 50/50 blend (-$123) | Yes (adds the `catboost` dependency) | Weights chosen on the same val as calibration, small optimism; blend gain is a variance effect, and my bag-5 XGB gets part of it (-$48) for free | Neutral | Test bagging first; add CatBoost only if a gain survives 3 splits plus the dealer-grouped gate. CatBoost's ordered target statistics suit the high-cardinality categories |
| More history, older than 180 days (-$270) | Yes | Not time-validated by them; my time-forward check (no drift penalty over a week) is only mildly supportive. Older rows are delisted cars with stale asking prices | Neutral to slightly negative if stale | Try 270 days with time-forward validation (idea 8) |
| Luxury weight x3 (-$77) | Yes | Safe | Neutral; changes balance between luxury and non-luxury | Optional; check per-band % error |
| Fractional age at listing date (-$18) | Yes | Fine; fixes the January 1 jump from `datetime.utcnow().year` at `pipeline.py:178` | Neutral | Adopt for correctness, not for accuracy |
| Their "no leakage found" statement | n/a | Mostly right for the test set. Not covered: scoring is in-sample for training rows (`db/repository.py:153-177`), and cohort stats for scoring include the row's own price | Directly affects deal detection | Idea 1 |
| Dropping zip3/state/colour hurts (+$157) | n/a | Correct, and consistent with my zip3 encoding being no better than the one-hot | n/a | Keep these features |
| Time-forward validation (listed as untested) | n/a | Run here, one week only | n/a | Keep in the gate set |

Their robustness claim (three splits) holds for MAE; what they did not report is median % error by price band, which is what the product uses. My ref reproduced their direction on MAE (XGB square error $3,342 on split 42 vs their D0 $3,378 3-seed), so the two studies agree.

## Other ideas considered and not recommended

- Pooled stacking meta-learner, neural nets, full hyperparameter sweeps: gains are inside seed noise at 6k rows (earlier study; my depth-4 test gave -$22 on one split).
- Monotone constraints on mileage: +$13 accuracy, but they remain a reasonable safety rail if odd predictions (price rising with mileage) show up in the UI. XGBoost docs: https://xgboost.readthedocs.io/en/stable/tutorials/monotonic.html .
- Quantile or per-listing uncertainty models: a deal-score improvement (an interval per listing instead of a band-wide yardstick). Start with the Mondrian table (idea 2); XGBoost `reg:quantileerror` (https://xgboost.readthedocs.io/en/stable/python/examples/quantile_regression.html) plus conformal calibration (Romano et al., https://arxiv.org/abs/1905.03222) is the next step if the table is not enough.
- Dropping `exterior_color` and `zip3`: hurts (earlier study).
- Unused stored columns: `location_city` (25 distinct values, nearly redundant with zip3), `body_style` (a copy of `body_type`, `data_ingest.py:194-196`), `condition` (1 value), `accident_count`/`owner_count`/`dealer_rating` (constant or null), `days_listed` (train/serve mismatch, see the earlier study). Nothing left to mine there.

## Out of scope (needs new data or new calls)

- Fields that Marketcheck may return in the search response but `map_listing` does not store (for example MSRP, price-change history, certified/seller type). The raw payload is not saved in the repo and I did not call the API, so I could not verify which ones exist; capturing them would change `map_listing` and only give data going forward.
- VIN decode (NHTSA vPIC) for engine, drivetrain, options: new external calls.
- True sold prices or days-to-sale as the training label (asking price is the label today).
- Condition, accident or owner-history data from vehicle history reports.
- Photos or description text.
- Lat/long for distance to major markets.
- External market indices (auction prices, regional demand).

## Reproduce

Scratchpad `/private/tmp/claude-501/-Users-danielpark-car-intel/92793188-e0c9-5e56-ad89-5e49ffb4f20b/scratchpad/x/`: `db.sqlite` is a copy of `car_intel.db` (live DB untouched). Run with the repo venv (`/Users/danielpark/car-intel/venv/bin/python`): `e0.py` target check, `e1.py` feature and model ladder on three splits, `e2.py` in-sample vs held-out, time-forward, dealer-grouped, `e3.py` Mondrian yardstick, `e4.py` LODO cohort. Total runtime about 15 minutes.

Limits: single fixed split family (VIN-grouped seeds 42/1/2, so the three splits overlap in rows), one XGB seed per cell except bagging; early stopping and calibration on the val split (the same choice production makes); the in-sample vs held-out comparison used one model and one split; the Mondrian numbers use a 1,491-row val set; 'flag rates' measure how often the score fires, not whether the flagged listings are real bargains, because the DB has no sold prices to check against.
