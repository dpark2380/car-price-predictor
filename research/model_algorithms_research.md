# Price model: algorithms that could beat the current XGBoost router

Run date 2026-10-31. Scope: model families not yet tested, or tested weakly. Builds on `model_research.md` (Block 4 tested LightGBM, CatBoost, RF and blends on an older, smaller dataset) and `model_improvement_research.md` (deal-score fairness, dealer warning). I read both, plus `ml/pipeline.py` and `requirements.txt`, and do not repeat them. No code in the repo was changed; the DB was read through a copy.

Facts checked in the repo: production is `PriceRouted` (`ml/pipeline.py:140`), two 5-seed XGB pipelines, log1p target, `reg:squarederror`, one-hot categoricals, other-dealer cohort and comp features (`_cohort_features`, `_comp_prices`). Hardware is an Apple M1, 8 cores, 8 GB RAM. The repo venv is Python 3.14.8 with xgboost 3.4.1, scikit-learn 1.9.1, numpy 2.5.3, pandas 3.0.6. LightGBM and CatBoost are not in `requirements.txt`.

Source rule: every claim has a link. "Unverified" means I could not open a primary source this session.

## Summary: ranked

| Rank | Algorithm | Why for us | Effort | Expected gain | Confidence |
|---|---|---|---|---|---|
| 1 | Blend XGB + CatBoost + LightGBM (equal weights, same features) | Native categoricals and different tree shapes make errors that differ from XGB. Measured here on 3 VIN splits | Low-medium (2 new deps, 2 more models in `PriceRouted`) | MAE about -$145 vs single XGB (2,985 -> 2,838), less vs the 5-seed bag. <$10k median % error 16.2 -> 15.1 | Medium-high on direction, medium on size (see caveats) |
| 2 | Split-conformal or quantile intervals for the deal flag (CQR via XGB/CatBoost/LightGBM quantile loss, optionally MAPIE) | Deal detection needs "is this price below the plausible range", not a point error. Fixes thin-cohort false flags with a coverage guarantee | Medium (new scoring path, no retrain of the point model) | No MAE change. Flag precision and a flat false-flag rate across cohorts | Medium-high |
| 3 | CatBoost alone as a third family, tuned (depth, l2, ordered boosting) | Ordered target statistics suit make/model/trim/zip3. Beat single XGB on all 3 splits here, 2x faster to fit | Low | -$56 vs single XGB, mostly captured by rank 1 | Medium |
| 4 | Monotone constraints on mileage and age | Stops physically wrong dips (a lower-mileage car priced lower), a source of false deals | Low (one XGB param) | MAE about 0 (+$13 earlier). Value is sanity, not accuracy | Medium that it is neutral on MAE, low on deal benefit |
| 5 | GPBoost (tree boosting plus random effects for make/model/trim) | Partial pooling for sparse cohorts, the same idea as the dealer-neutral note in the improvement study | Medium-high (new dep, new API, new inference path) | Unknown. Could help thin cohorts | Low-medium |
| 6 | TabPFN (v2 weights or newer) | Strong on small tabular data | High, and weights licence is a blocker | Unknown. Row limits and CPU time work against us | Low |
| 7 | RealMLP / TabM / FT-Transformer | Can match GBDTs in benchmarks and add ensemble diversity | High (torch, CPU training, tuning) | Likely small at 17.5k rows, only as a blend member | Low |

Top recommendation: ship rank 1 only if it also passes the dealer-grouped and time-forward gates from `model_improvement_research.md`, and add rank 2 for the product goal. The rest are optional.

## Experiment: XGB vs CatBoost vs LightGBM vs blends on the production split

What I ran. Same rows as production (17,893 rows in `training_pool_v` after the 180-day window), same features as the router's "rest" model (including `comp_price`), same other-dealer cohort features, `_vin_split` seeds 42, 1, 2, log1p target, val-median calibration offset like production. Each model uses early stopping on the val split. Test MAE in dollars. Exact command is in "Reproduce".

| Model | MAE seed 42 | seed 1 | seed 2 | Mean MAE | <$10k median % error | Mean fit time |
|---|---|---|---|---|---|---|
| XGB, one seed, fixed params (lr 0.05, depth 6) | 2,955 | 3,026 | 2,975 | 2,985 | 16.2 | 38 s |
| CatBoost RMSE, native cats (depth 7, lr 0.06) | 2,917 | 2,926 | 2,946 | 2,929 | 16.2 | 18 s |
| LightGBM, native cats (31 leaves, cat_smooth 20) | 2,912 | 2,901 | 2,939 | 2,917 | 15.4 | 6 s |
| XGB + CatBoost, 50/50 | 2,856 | 2,876 | 2,879 | 2,870 | 15.1 | n/a |
| XGB + CatBoost + LightGBM, equal | 2,819 | 2,837 | 2,859 | **2,838** | 15.1 | n/a |

Reading it.
- The three-way blend beats single XGB on every split, by $136 to $188. The ordering is the same on all three splits.
- The earlier Block 4 result (blend about -$160, CatBoost and LightGBM near XGB alone) reproduces on 3x the data and the current feature set. This is new evidence, not a repeat.
- Caveat 1: my XGB is one seed with fixed params. Production uses a tuned, 5-seed bag, and `model_improvement_research.md` measured bagging at -$48. So the real gain over production is probably about $90 to $110, not $145. I did not rerun the production bag. Treat as unverified.
- Caveat 2: LightGBM and CatBoost were not tuned either, and equal blend weights are not fit to the val split, so there is no weight-selection bias.
- Caveat 3: three splits of one dataset, one seed per model. Seed sd in earlier studies was $19 to $74. Gaps over $100 are outside that noise, gaps under $50 are not.
- Caveat 4: not tested on dealer-grouped or time-forward splits. Native categoricals on `zip3` and `trim` can act as dealer proxies, so the dealer-grouped gate matters before shipping.
- Test rows include `cheap` and `rest` routing only implicitly. I used the full-feature model for everyone, so the <$10k column is a rough guide, not the routed number.
- Fit times are on an idle M1 with 8 threads and are a single fit. The production job runs a 24-fit grid per XGB, so the added cost of one CatBoost and one LightGBM fit (about 25 s) is small.

## 1. Blend of GBM families (XGB + CatBoost + LightGBM)

**What.** Average log-price predictions of three boosted-tree libraries. Stacking with a fitted meta-learner is a variant, but simple averaging avoids overfitting a meta-model on about 3,000 val rows.

**Why for us.**
- The measured gain above.
- CatBoost replaces category values with ordered target statistics: each row's encoding uses only rows earlier in a random permutation, so its own label never leaks in ([CatBoost docs](https://catboost.ai/docs/en/concepts/algorithm-main-stages_cat-to-numberic); [Prokhorenkova et al., NeurIPS 2018](https://arxiv.org/abs/1706.09516)). It can also combine categoricals (make x trim). Our data has model, trim, zip3 and colour with many rare levels, which is its target case.
- LightGBM handles categoricals with a sorted-gradient split search, and `cat_smooth`, `min_data_per_group` and `cat_l2` control noise from rare categories ([LightGBM parameters](https://lightgbm.readthedocs.io/en/stable/Parameters.html)).
- TabArena finds that cross-model ensembles reach the best results on its benchmark ([Erickson et al., TabArena](https://arxiv.org/abs/2506.16791)).

**Limits.**
- CatBoost 1.2.10 has wheels for CPython 3.8 to 3.14 and macOS arm64, licence Apache 2.0 ([PyPI](https://pypi.org/project/catboost/)). I installed it and LightGBM 4.7.0 on Python 3.14 in a separate venv; both imported and trained fine. LightGBM's PyPI page would not load, so its licence (MIT) and wheel list are unverified here; I only verified the install worked.
- Two new dependencies in a production venv that serves the API. `joblib` pickles of CatBoost and LightGBM models tie the saved model to library versions, like XGB already does.
- The deal-score yardstick (`_segment_errors`) must be recomputed on blend residuals.

**Effort.** Add two pipelines next to `xgb_rest` and `xgb_cheap` at `pipeline.py:477-520`, inside `PriceRouted` or a small `Blend` wrapper. CatBoost needs string categoricals with no NaN; LightGBM needs `category` dtype with fixed training categories. About 60 lines plus `requirements.txt`.

**Expected payoff.** About -$90 to -$145 MAE (see caveat 1), and about -1 point on <$10k median % error. Confidence medium-high on direction, medium on size.

**Gate before adoption.** Dealer-grouped holdout MAE no worse than the dealer-free baseline, three splits, paired differences.

## 2. Quantile and conformal intervals for "is this a deal"

**What.** Instead of flagging by z-score against a per-band error yardstick, build an interval for the plausible price of each listing. A listing priced below the lower bound is a deal.

**Why for us.** `model_improvement_research.md` measured false-flag rates of 14.9% for cohorts with under 3 training rows vs 2.0% for 30+ rows. The root cause is that one yardstick per price band ignores how uncertain each cohort is.

**Options, in rising effort.**
- Split conformal on absolute log residuals with bins by `cohort_count` and price band (the "Mondrian" idea in the improvement study, rank 2). No new library.
- Conformalized quantile regression (CQR): fit lower and upper quantile models, then adjust with a calibration set. It adapts interval width to the row and carries a finite-sample coverage guarantee with no distribution assumption ([Romano, Patterson, Candes 2019](https://arxiv.org/abs/1905.03222)). The guarantee needs calibration and test rows to be exchangeable. Our scored listings include dealer-sibling and in-train cars, so the guarantee holds only if the calibration set is built like the scoring set (cross-fitted, not in-sample).
- Quantile losses exist in CatBoost (`Quantile`, `MultiQuantile`, `RMSEWithUncertainty`; [CatBoost regression losses](https://catboost.ai/docs/en/concepts/loss-functions-regression)). XGBoost has a quantile objective too, but I could not open its docs page (404), so the version and multi-quantile details are unverified. LightGBM also has `objective="quantile"` (unverified this session).
- MAPIE wraps conformal methods for regression, BSD-3-Clause ([MAPIE docs](https://mapie.readthedocs.io/en/latest/)). I could not read its Python version list or the exact method names from that page; unverified. For one model in one daily job, a hand-written split-conformal step is a few lines and avoids a dependency.
- NGBoost predicts a full distribution by boosting distribution parameters ([Duan et al., ICML 2020](https://arxiv.org/abs/1910.03225)). It is slower than tuned XGB and gives a parametric (usually Normal) shape. On log-price with heteroscedastic noise it is a candidate, but I would try CQR first. Python 3.14 support unverified.

**Effort.** Medium. Calibration data must be out-of-sample (the improvement study already proposes cross-fitted scoring, rank 1). Changes `_deal_score_from_prices` (`pipeline.py:864`) and stored model payload. No point-model change.

**Expected payoff.** No MAE gain. Product gain: fewer false deals on thin cohorts and a "how sure" field. Confidence medium-high; I did not measure it here.

## 3. CatBoost as a standalone family

**What.** Replace or add to XGB. Settings to tune: `depth`, `l2_leaf_reg`, `one_hot_max_size`, `boosting_type="Ordered"` (slower, aimed at small data; I did not test it), `cat_features` combinations.

**Evidence.** -$56 vs single XGB, better on all 3 splits, 18 s fit (above). Block 4 earlier found the same size. It does not beat the three-way blend.

**Limits.** Same as section 1. CatBoost's MAE loss was worse than RMSE in Block 4 (+$93), so keep RMSE on the log target.

**Payoff.** Small alone. Use it as a blend member. Confidence medium.

## 4. Monotone constraints (price falls with mileage and age)

**What.** XGBoost `monotone_constraints` (`-1` on mileage, age) forces predictions to be non-increasing in those features ([XGBoost docs](https://xgboost.readthedocs.io/en/stable/tutorials/monotonic.html)). LightGBM has the same, with `monotone_constraints_method` (basic is fastest but over-constrains) ([LightGBM parameters](https://lightgbm.readthedocs.io/en/stable/Parameters.html)).

**Known limits.** Shallow trees with `hist` can lose all split candidates under constraints; raising `max_bin` helps ([XGBoost docs](https://xgboost.readthedocs.io/en/stable/tutorials/monotonic.html)). Our features include `mileage`, `log_mileage`, `miles_per_year`, `vehicle_age`, `age_sq`, `lux_age` and more, all functions of the same two quantities. Constraining only some of them does nothing, because the model can route around a constrained column through the others. This is probably why the earlier test gave +$13 (`model_improvement_research.md`).

**Effort and payoff.** One param, but needs all mileage and age features constrained consistently (age_sq is not monotone as written). Expected MAE change about 0. A possible deal-detection benefit, since non-monotone dips are the kind of artefact that makes a high-mileage car look overpriced or a low-mileage car look cheap. I did not test that. Confidence low-medium.

## 5. Mixed-effects (random effects per make/model/trim) and GPBoost

**What.** Hedonic pricing with partial pooling: price = f(features) + random effect for make/model/trim (and possibly dealer). The cohort medians in the pipeline already approximate this by hand. GPBoost fits a tree ensemble for the fixed part and a grouped random-effects model jointly ([Sigrist, arXiv 2004.02653](https://arxiv.org/abs/2004.02653); the search summary says it handles high-cardinality categoricals; I did not read the paper body, so treat the detail as unverified).

**Why for us.** Thin cohorts (the improvement study's weakest spot) get shrunk toward the parent, which is what `n/(n+k)` empirical-Bayes shrinkage does. A random effect for dealer gives the "dealer-neutral" scoring the dealer warning asked for: train with a dealer effect, then predict with it set to zero. That is a cleaner version of the untested partial-dependence idea (Efron and Morris, [JASA 1973](https://doi.org/10.1080/01621459.1973.10481350)).

**Limits.** GPBoost 1.8.0 (2026-10-21), Apache-2.0, Python 3.7 to 3.14 classifiers ([PyPI](https://pypi.org/project/gpboost/)). I did not install or run it. It has its own API, not a scikit-learn estimator, so `PriceRouted` and the pickle path need an adapter. Python statsmodels `MixedLM` is the plain linear option; I did not verify its docs this session.

**Effort.** Medium-high. **Payoff.** Unknown, I did not test it. Highest potential for deal detection of any item here besides the intervals, because of the dealer effect. Confidence low-medium. A small experiment (GPBoost with a dealer random effect, scored with dealer effect off, on the dealer-grouped split) would settle it.

## 6. TabPFN (tabular foundation model)

**What.** A pretrained transformer that fits a dataset in one forward pass. TabPFN-v2 is in [Hollmann et al., Nature 2025](https://www.nature.com/articles/s41586-024-08328-6). The page redirected to a login, so its numbers and the original 10,000-row limit are unverified.

**Limits from the official README ([PriorLabs/TabPFN](https://github.com/PriorLabs/TabPFN)).**
- CPU sample limit is 5,000 rows for TabPFN-3 / 3.5 and 1,000 for older versions. It can be overridden with `TABPFN_ALLOW_CPU_LARGE_DATASET=true`, but large CPU runs are slow. We have 17.5k to 17.9k training rows, 3.5x the limit.
- The README recommends a GPU. It says Apple Silicon GPU support is included and PyTorch 2.13 or newer is best for it. I did not test speed on the M1.
- Python 3.10 to 3.14.
- Licence: code is Apache-2.0. Weights for TabPFN-2.5, 2.6, 3 and 3.5 are under non-commercial licences. TabPFN-2 weights use the Prior Labs License (Apache-2.0 plus attribution). If car-intel is or becomes a product, this is a blocker for the newer weights.
- A cloud API client exists for no-GPU users; that would send listing data to a third party (the README says the local package keeps data local).
- High-cardinality categoricals: the README does not state a limit. Unverified.

**Verdict.** Good fit for small data; ours is not small. Could be tried on a subsample as a blend member, but the licence and row limit make it a poor production fit. Payoff unknown. Confidence low.

## 7. Tabular deep learning: RealMLP, TabM, FT-Transformer

**Evidence.**
- Grinsztajn et al. find tree models are still state of the art on medium data (about 10K rows), and attribute it to inductive biases; neural nets need robustness to uninformative features and irregular functions ([arXiv 2207.08815](https://arxiv.org/abs/2207.08815)). That benchmark is on 45 datasets and I could not confirm what it says about categoricals.
- RealMLP: pre-tuned MLP competitive with GBDTs, favourable time-accuracy tradeoff, 1K to 500K rows ([Holzmuller et al., NeurIPS 2024](https://arxiv.org/abs/2407.04491)).
- TabM: MLP with parameter-efficient ensembling, best among tabular deep models; the paper's page made no GBDT comparison ([Gorishniy et al., ICLR 2025](https://arxiv.org/abs/2410.24210)).
- FT-Transformer: the paper concludes "still no universally superior solution" vs GBDT ([Gorishniy et al., NeurIPS 2021](https://arxiv.org/abs/2106.11959)).
- TabArena: GBDTs remain strong; deep models catch up with larger budgets and ensembling, and some deep models look better than they are because of validation overfitting ([TabArena](https://arxiv.org/abs/2506.16791)). Its repo lists RealMLP and TabM in the core set ([tabrepo](https://github.com/autogluon/tabrepo)).

**Limits for us.** No GPU, 8 GB RAM, torch dependency, long tuning, and a model that must be retrained daily on a Mac mini. Python 3.14 wheels for torch and the implementations (e.g. `pytabkit`) are unverified. I did not run any of them.

**Payoff.** At best a small blend gain on top of rank 1. Not worth the dependency now. Confidence low.

## Considered and rejected

- **Random forest as a primary model.** Already weaker (test MAE about $3,236 vs $2,964) and adds little in a blend (Block 4).
- **LightGBM or CatBoost with the MAE loss.** CatBoost MAE was +$93 worse in Block 4, and absolute-error objectives were already dropped for XGB.
- **Fitted stacking meta-learner.** With 1.5k to 3k val rows it risks overfitting; equal-weight averaging already captured the gain here.
- **Separate luxury model.** Halves the data, +$95 in Block 4.
- **NGBoost as the primary model.** Slow, parametric, no accuracy claim for tabular point prediction; use only if CQR is not enough.
- **Hosted TabPFN API.** Sends listing data off the box and adds an external dependency.
- **Linear-leaf trees** (`linear_tree` in LightGBM, [docs](https://lightgbm.readthedocs.io/en/stable/Parameters.html)). Not tested; depreciation is smooth, so it might help, but it does not combine with many options (serial tree learner, CPU). Listed as a cheap curiosity, not a recommendation.

## Reproduce

Setup (separate venv, does not touch the repo venv). The DB is copied with SQLite's read-only backup API:

```sh
S=/private/tmp/claude-501/-Users-danielpark-Documents-Projects-car-intel/60adfdb9-8d02-493a-9a14-b40d473bad40/scratchpad
cd $S
/Users/danielpark/car-intel/venv/bin/python -m venv exp
exp/bin/pip install numpy pandas scikit-learn xgboost sqlalchemy loguru python-dotenv catboost lightgbm
python3 - <<EOF
import sqlite3
s = sqlite3.connect("file:/Users/danielpark/car-intel/car_intel.db?mode=ro", uri=True)
d = sqlite3.connect("$S/car_intel_copy.db"); s.backup(d); d.close()
EOF
```

Run (about 3.5 minutes on the M1 mini, 17,893 rows):

```sh
PYTHONPATH=/Users/danielpark/car-intel exp/bin/python $S/exp_gbm.py $S/car_intel_copy.db 42 1 2
```

Script: `/private/tmp/claude-501/-Users-danielpark-Documents-Projects-car-intel/60adfdb9-8d02-493a-9a14-b40d473bad40/scratchpad/exp_gbm.py`. It imports `ml.pipeline` helpers (`_build_features_raw`, `_cohort_ref`, `_cohort_features`, `_vin_split`) so features and splits match production. Installed versions: catboost 1.2.10, lightgbm 4.7.0, xgboost 3.4.1, numpy 2.5.4, Python 3.14.8. The scratchpad is session-scoped; copy the script into `scripts/` if you want to keep it.

## Not verified

- Production-bag comparison: I did not rerun the tuned 5-seed XGB router, so the gain over production is inferred (about $90 to $110), not measured.
- Dealer-grouped and time-forward results for the blend and for CatBoost/LightGBM native categoricals.
- XGBoost and LightGBM quantile objective docs (XGBoost page 404; LightGBM not opened).
- MAPIE Python versions and method list; NGBoost Python 3.14 support; GPBoost paper details and any run; statsmodels `MixedLM` docs.
- TabPFN Nature paper numbers and its original row limit; categorical limits; M1 speed.
- LightGBM licence and wheel list (PyPI page failed to load).
- torch / `pytabkit` support on Python 3.14; RealMLP, TabM, FT-Transformer timings on CPU.

## Follow-up: blend vs production router

Run date 2026-10-31. Question: does the equal-weight XGB + CatBoost + LightGBM blend beat the production `PriceRouted`, not just one untuned XGB, and does the gain hold on dealer-grouped and time-forward splits? No repo code, `models/`, `logs/` or the live DB was touched; data is the same read-only copy (17,893 rows).

What ran:

- **Baseline** = `PriceRouted` rebuilt from `ml/pipeline.py`: two 5-seed XGB bags (cheap side without `comp_price`, rest side with it), same one-hot preprocessing, same `_cohort_features`/`_comp_prices`, routing on the cheap bag's own prediction at $10k, calibration offset = median val log residual of the routed output.
- **Candidate A** = each side is the equal mean (log space) of its XGB bag, CatBoost and LightGBM. The router then uses A's blended cheap prediction. **Candidate B** = cheap side stays the XGB bag (routing unchanged), only the rest side (>= $10k) is blended.
- CatBoost and LightGBM use the exp_gbm.py settings, untuned, early stopping on val (3,000 trees max).
- Splits: VIN seeds 42/1/2 (`_vin_split`); dealer-grouped seeds 42/1/2 (`GroupShuffleSplit` on `_dealer_keys`, same 64/16/20 carve as the VIN split); time-forward = oldest 64% by `first_seen` train, next 16% val, newest 20% test (one split; the improvement study used `last_seen`).
- Deal proxy, using `model_improvement_research.md` definitions: the production yardstick (`_segment_errors` from val, by price band and cohort size) and `_deal_score_from_prices`; "flagged" = 4+ stars (score >= 75, z >= 1.875), and 5 stars (>= 90). Reported as the share of test listings flagged, by price tier, plus the Jaccard overlap of the flagged sets against baseline.

Deviation from a faithful reproduction: I did **not** re-run the grid search. XGB params come from the latest production artifact (`models/price_predictor.joblib`, v20261030_2312, read-only): cheap lr 0.05 / 1,405 trees, rest lr 0.03 / 1,479 trees, other params from `xgb_fixed_params`. Those were tuned on the seed-42 VIN split, so they are slightly favourable to baseline on that split and mildly mismatched on the others. No early stopping for the baseline (production has none at fit time either); CatBoost and LightGBM do early-stop on the val split, which production's XGB does not, a small advantage to the candidates (see Not verified).

### VIN splits (test n = 3,579 each)

| Config | MAE 42 / 1 / 2 | Mean MAE | Median APE % | Median APE % <$10k | 4+ star % | 5 star % | 4+ star overlap vs base |
|---|---|---|---|---|---|---|---|
| Baseline router | 3,002 / 3,036 / 2,982 | 3,007 | 8.14 | 15.54 | 9.40 | 2.78 | 1.00 |
| A: blend both sides | 2,833 / 2,848 / 2,867 | 2,849 | 7.59 | 14.82 | 9.87 | 3.15 | 0.71 |
| B: blend rest only | 2,834 / 2,853 / 2,875 | 2,854 | 7.60 | 15.20 | 9.77 | 3.07 | 0.73 |

### Dealer-grouped splits (test n = 2,934 / 3,335 / 5,328)

| Config | MAE 42 / 1 / 2 | Mean MAE | Median APE % | Median APE % <$10k | 4+ star % | 5 star % | 4+ star overlap vs base |
|---|---|---|---|---|---|---|---|
| Baseline router | 3,011 / 3,868 / 2,973 | 3,284 | 9.50 | 17.95 | 10.45 | 4.13 | 1.00 |
| A: blend both sides | 2,961 / 3,746 / 2,886 | 3,198 | 9.37 | 18.44 | 10.92 | 4.34 | 0.73 |
| B: blend rest only | 2,960 / 3,752 / 2,889 | 3,200 | 9.39 | 18.07 | 11.08 | 4.30 | 0.76 |

### Time-forward split (train oldest 64%, test newest 20%, n = 3,579, one split)

| Config | MAE | Median APE % | Median APE % <$10k | 4+ star % | 5 star % | 4+ star overlap vs base |
|---|---|---|---|---|---|---|
| Baseline router | 2,924 | 8.90 | 16.85 | 8.33 | 1.54 | 1.00 |
| A: blend both sides | 2,835 | 8.43 | 17.39 | 8.44 | 1.59 | 0.64 |
| B: blend rest only | 2,838 | 8.56 | 16.78 | 8.21 | 1.56 | 0.68 |

Paired MAE difference, A minus baseline, per split: VIN -169 / -188 / -115; dealer -50 / -122 / -86; time -89. A is better on all 7. The dealer-grouped gain (-$86 mean) is about half the VIN gain (-$158), so part of the VIN gain is dealer-proxy variance reduction, but it does not vanish.

4+ star flag rate by price tier (mean over splits of that type; baseline / A / B, %):

| Tier | VIN | Dealer-grouped | Time-forward |
|---|---|---|---|
| < $10k | 13.0 / 13.8 / 12.9 | 13.7 / 13.3 / 14.5 | 11.5 / 13.5 / 12.2 |
| $10-20k | 10.7 / 11.4 / 11.2 | 11.9 / 11.5 / 11.5 | 8.7 / 8.0 / 7.6 |
| $20-35k | 9.8 / 10.2 / 10.4 | 11.1 / 12.4 / 12.4 | 8.1 / 7.8 / 7.9 |
| $35-60k | 6.8 / 6.9 / 6.9 | 6.6 / 7.7 / 7.8 | 7.1 / 8.6 / 8.6 |
| > $60k | 2.9 / 3.4 / 3.4 | 1.7 / 1.3 / 1.3 | 2.5 / 0.0 / 0.0 (n = 121) |

Fit time (seconds, mean per side, M1, 8 threads): XGB 5-seed bag 13-15 (cheap) and 14 (rest); CatBoost 7-17; LightGBM 4-5. A adds about 20-25 s per side over the baseline's bag, B adds about 20-25 s total, on every fit. `train()` also refits the winning model 5 times for out-of-fold scores, so a daily retrain grows by the same factor on that step. Total experiment runtime about 9 minutes.

### Verdict

Ship **B** (blend CatBoost and LightGBM with the XGB bag on the >= $10k side only), conditional on the follow-ups below. The blend beats the tuned production router, not only a single XGB: mean MAE -$153 on VIN splits (3,007 to 2,854), -$84 on dealer-grouped (3,284 to 3,200), -$86 on time-forward (2,924 to 2,838), better on all 7 splits, and better in every price tier by MAE. A is no more accurate than B (within $7 on each split type) but moved the under-$10k median % error the wrong way on dealer-grouped (17.95 to 18.44) and time-forward (16.85 to 17.39), the band the improvement study cares about; B is level with baseline there on dealer and time (18.07 vs 17.95, 16.78 vs 16.85) and gains 0.3 on VIN. Deal proxy: flag rates move by 0.1 to 0.7 points overall and no tier shifts by more than about 2 points except the n = 121 top tier on the time split (2.5 to 0%, 3 listings), so the blend does not obviously inflate or hide deals, but the flagged sets only overlap 64-76% with baseline's (Jaccard), so which cars are flagged changes materially. Needs before shipping: (1) add catboost and lightgbm to `requirements.txt` and confirm both have Python 3.14 wheels in the repo venv (verified only in the scratch venv); (2) implement the blend as a `PriceRouted` rest model whose predict averages the three in log space, with CatBoost/LightGBM fed the raw categorical frame, and save and load it through joblib; (3) re-derive the segment yardstick from the blend's val and OOF errors (production does this already, but check the `segment_errors` shift); (4) check flag rates for the largest dealers, as the improvement study asks; (5) rerun this on the next DB snapshot, since the time-forward result is one split of one week.

### Reproduce

```sh
S=/private/tmp/claude-501/-Users-danielpark-Documents-Projects-car-intel/60adfdb9-8d02-493a-9a14-b40d473bad40/scratchpad
cd $S   # needs exp/ venv and car_intel_copy.db, see "Reproduce" above
PYTHONPATH=/Users/danielpark/car-intel exp/bin/python exp_router_blend.py $S/car_intel_copy.db $S/rb_vin.json vin:42 vin:1 vin:2
PYTHONPATH=/Users/danielpark/car-intel exp/bin/python exp_router_blend.py $S/car_intel_copy.db $S/rb_dt.json dealer:42 dealer:1 dealer:2 time:0
exp/bin/python rb_tables.py $S    # prints the tables above
```

Scripts: scratchpad `exp_router_blend.py` and `rb_tables.py` (same directory as above); durable copies at `scripts/exp_router_blend.py` and `scripts/exp_router_blend_tables.py` (they need the scratch venv with catboost and lightgbm, not the repo venv). Each split takes about 1 to 1.5 minutes, about 9 minutes in total.

### Not verified

- The grid search itself (artifact params used, see above); a fresh tuning per split could move the baseline either way.
- Candidate early stopping on val versus baseline without it: I did not run a baseline with val early stopping or the blend without it, so some of the gain could be that asymmetry. Earlier single XGB with val early stopping scored 2,985 on VIN here against baseline's 3,007, so the effect is probably under about $25, but this is inferred.
- Time-forward is one split and uses `first_seen`; the improvement study used `last_seen`. Dealer-grouped test sizes vary 2.9k to 5.3k because large dealers land on one side.
- Deal proxy is flag rate, not precision; there are no ground-truth deals. The 5-star and top-tier counts are small.
- No significance test; with 3,000+ test rows the paired differences are about 3 to 6% of MAE and consistent in sign, but only 7 splits.
- Inference path, wheel availability for the repo venv, and training/serving latency of the blend were not tested.
