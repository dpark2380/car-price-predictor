# CarIntel Repo Audit

**Scope:** claims verified strictly against committed code and committed outputs.
**HEAD at audit time:** `42f4fa4` ("updated db"), branch `main`.
**Audit date:** 2026-08-14.

## Critical framing: committed vs. working tree

The repo has substantial uncommitted changes, and **every headline number in the resume
bullets lives in uncommitted files.** This distinction decides most answers below.

| Artifact | Committed (HEAD `42f4fa4`) | Working tree (uncommitted) |
|---|---|---|
| `car_intel.db` rows | 8,415 | 11,471 |
| Modelling rows after filters | 7,731 | 10,486 |
| `logs/training_log.csv` last run | 2026-05-06, n=8,403 | 2026-07-04, n=10,486 |
| Best XGB MAE in log | $2,752 (n=6,023, 2026-04-22) | $2,753 (n=11,457, 2026-06-17) |
| `models/price_predictor.joblib` | v`20260506_0615`, XGB MAE $2,879.1 | v`20260704_1424`, XGB MAE $2,795.4 |
| `TECHNICAL_README.md` tier table | hypothetical (MAE ÷ round price) | measured per-tier |

`git diff --stat` shows 17 modified files including `car_intel.db`,
`models/price_predictor.joblib`, `logs/training_log.csv`, `ml/pipeline.py`, and
`TECHNICAL_README.md`.

---

## 1. How listing data is obtained

**Source: the Marketcheck REST API. There is no HTML scraping.**

- `scraper/data_ingest.py:23` — `BASE = "https://mc-api.marketcheck.com/v2"`
- `scraper/data_ingest.py:291-303` — `requests.get(f"{BASE}/search/car/active", params={...})`,
  authenticated with `api_key` (`scraper/data_ingest.py:293`).
- `scraper/marketcheck_enrichment.py:18` — same `BASE`; endpoints
  `/search/car/popular` (`:56`) and `/search/car/recents` (`:104`).

Responses are consumed as JSON (`scraper/data_ingest.py:306` — `r.json().get("listings", [])`)
and field-mapped in `map_listing` (`scraper/data_ingest.py:161-212`).

**No HTML parsing exists.** `requirements.txt` contains no `beautifulsoup4`, `bs4`,
`lxml`, `selenium`, or `playwright`. A recursive grep for those tokens plus
`html.parser` across all `.py` returns zero hits.

The single misleading artifact is a default argument:
`db/repository.py:86` — `def mark_inactive(self, scrape_source: str = "cars.com", ...)`.
This is vestigial: grep for `mark_inactive` across the repo returns **only the
definition — it is never called**. No cars.com request is ever made.

**Which source produced the modelling dataset:** `/search/car/active`. Training reads
`ListingRepository.get_active_listings_df()` (`scheduler/runner.py:144`), which reads the
`car_listings` table; `scrape_source` distribution in the working-tree DB is
`used_cars` 6,255 / `suvs` 3,325 / `trucks` 1,776 / `recents` 115. The first three come
from `/search/car/active` via `TARGET_PARAMS` (`scraper/data_ingest.py:351-355`);
`recents` (115 rows, 1.0%) came from the `/search/car/recents` enrichment endpoint.
All Marketcheck, all API.

> Terminology note: the module is named `scraper/` and the README says "scraped"
> (`TECHNICAL_README.md:685`), but the mechanism is a licensed API with a key and a
> call budget (`scraper/api_usage.py`). Describing this as "scraping" overstates it.

## 2. Row counts

Both computed by replicating the exact filter chain in code.

**Raw data** (`car_listings` table, no filters):
- Committed DB: **8,415**
- Working tree DB: **11,471**

**Modelling dataset** — filters applied in two stages:
1. `db/repository.py:102-112` — `is_active == True`, `price > 500`, `year` not null, `mileage` not null
2. `ml/pipeline.py:333-348` — dropna on price/mileage/year/make/model;
   `price.between(3_000, 100_000)` (`:339`); `mileage.between(0, 400_000)` (`:340`);
   `days_listed <= 365` (`:347-348`, `STALE_LISTING_MAX_DAYS`)

- Committed DB: **7,731** (675 rows dropped by the stale filter, 11 by the price band)
- Working tree DB: **10,486** — matches `logs/training_log.csv` last row (`n_rows=10486`) exactly

**Is it 10,000+?**
- On committed evidence: **No.** 8,415 raw / 7,731 modelling.
- On the uncommitted working tree: **Yes**, narrowly — 11,471 raw / 10,486 modelling.

The largest committed `total_active` ever logged is 8,415
(`logs/scrape_log.csv`, last committed row `2026-05-06 06:14`). The committed repo has
never seen 10,000 listings.

## 3. Snapshot or refreshed?

**Refreshed, but manually. There is no scheduler.**

`scheduler/runner.py` is a one-shot argparse CLI, not a daemon:
- `scheduler/runner.py:173-179` — `--once`, `--scrape-only`, `--train-only`, `--score-only`
- `scheduler/runner.py:159-170` — `run_all()` executes scrape → train → score → popularity once and returns
- `scheduler/runner.py:217-218` — `if __name__ == "__main__": main()`

No cron, no APScheduler, no Celery, no systemd timer. `requirements.txt` lists no
scheduling library. `Procfile:1` is `web: PYTHONPATH=. python start.py`, which serves
the Flask API only (`start.py:63-64`) and never invokes the runner. The only CI workflow,
`.github/workflows/pr-visual-recap.yml`, triggers on `pull_request` and is unrelated to
data.

Evidence of refresh is the run history itself: `logs/scrape_log.csv` records 26 runs
between 2026-04-22 and 2026-06-17 at irregular, clustered, human-looking times
(e.g. three runs within four minutes on 2026-06-07). That is a person running a command,
not a schedule.

**Related defect:** because `mark_inactive` (`db/repository.py:86-100`) is never called,
`is_active` is never set to 0. All 11,471 rows are `is_active=1`. The dataset is
cumulative and never expires — a listing first seen in April is still counted as "active"
in August whether or not it is still for sale.

## 4. Where the 8% is computed

**`ml/pipeline.py:594-611`.** The function:

```python
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
    _tier_mae  = float(np.mean(np.abs(pred_test[_mask] - y_true[_mask])))   # :607
    _tier_mean = float(np.mean(y_true[_mask]))                              # :608
    _tier_pct  = _tier_mae / _tier_mean * 100                               # :609
    _tier_parts.append(f"{_label} ${_tier_mae:,.0f} ({_tier_pct:.0f}%,n={_n})")
logger.info("  tiers | " + " | ".join(_tier_parts))                         # :611
```

**Answer: it is an aggregate, and it is neither mean nor median per-listing error.**

`ml/pipeline.py:609` divides one aggregate (bucket MAE) by another aggregate (bucket
mean price). It is a ratio of two summary statistics. No per-listing percentage error
is ever computed here, so no median of one can be taken.

The value is **logged only** (`:611`) — never persisted to
`logs/training_log.csv` (`scheduler/runner.py:52-71` writes no tier fields) and never
stored in the model payload (`ml/pipeline.py:661-668`). The README table is a manual
transcription of a log line.

**Where the 8% appears in prose:**
- Uncommitted `TECHNICAL_README.md:630` — `| $20–35k | $2,147 | ~8% | 789 |`
- Committed `TECHNICAL_README.md:627-629` — a *different, hypothetical* table:
  `| $35,000 car | ~$2,786 | ~8% |`, computed as overall MAE ÷ a round price.
  In the committed version, a $20,000 car is listed at **~14%**, not 8%.

Ironically the uncommitted README explicitly condemns the committed version's method
(`TECHNICAL_README.md:636`): *"it is tempting to quote the overall MAE ($2,753) against
every tier — e.g. '$2,753 / $20,000 ≈ 14%.' That is wrong."*

**The only per-listing percentage error in the repo** is
`scripts/model_sanity_check.py:96` — `df["pct_error"] = df["residual"] / df["price"] * 100`.
It is **signed, not absolute** (`:95`), and computed on all scored DB listings
(`:92-94`) — which include the training rows, so it is in-sample. Its `describe()`
output (`:105-106`) would report a median near zero (that is what the calibration step
is designed to produce), not 8%.

## 5. Is the 8% the $20-35k subset, and what is the full-dataset figure?

Yes — the 8% is the `$20-35k` bucket specifically (`TECHNICAL_README.md:630`, uncommitted).

I reproduced the exact split and metric against the currently saved model
(v`20260704_1424`, 10,486 modelling rows, 2,098 test rows; reproduction returned
MAE $2,795, matching the training log to the dollar):

| Tier | n | MAE | MAE÷mean (the pipeline's "%") | **median** APE | mean APE |
|---|---|---|---|---|---|
| <$10k | 233 | $1,479 | 20.6% | 15.7% | 21.6% |
| $10–20k | 470 | $2,077 | 13.3% | 9.3% | 13.8% |
| **$20–35k** | 807 | $1,980 | **7.4%** | **3.9%** | 7.4% |
| $35–60k | 437 | $4,093 | 9.1% | 4.9% | 8.7% |
| >$60k | 151 | $7,668 | 10.4% | 5.0% | 10.3% |
| **FULL DATASET** | **2,098** | **$2,795** | **9.6%** | **6.0%** | **10.9%** |

**Equivalent full-dataset figures:** aggregate MAE÷mean price = **9.6%**;
true median absolute percentage error = **6.0%**; mean APE = **10.9%**.

Two things follow. The `$20-35k` figure is real and is genuinely the best band — the
segment claim holds directionally. But the statistic labelled "8%" tracks the *mean*
APE (7.4% vs 7.4%), not the median (3.9%).

## 6. MAE $2,753 and linear baseline $4,908

**Not confirmable from committed outputs.**

The committed `logs/training_log.csv` ends at `2026-05-06 06:15` and contains no such
row. Its best XGB result is `$2,752` — but that run pairs with `linear_mae=5049`, on
`n_rows=6023`. The pair (2753, 4908) does not exist at HEAD.

The pair exists only in the **uncommitted** `logs/training_log.csv`, row 26:

```
2026-06-17 03:28,20260617_0328,11457,9165,2292,xgb,4907.6,4324.8,3146.6,2753.0,5011.4,3608.0,2391.6,0.15,1439
```

- `xgb_mae` = **2753.0** ✓
- `linear_mae` = **4907.6** → rounds to $4,908 ✓
- `n_rows` 11,457 · `train_rows` 9,165 · `test_rows` 2,292

**Which split produced them:** a single 80/20 `train_test_split` with
`random_state=42` — `ml/pipeline.py:360-362`:

```python
X_train, X_test, y_train, y_test = train_test_split(
    X_raw, y, test_size=0.2, random_state=42
)
```

**Neither model artifact in the repo reproduces these numbers:**
- Committed `models/price_predictor.joblib` → v`20260506_0615`, XGB $2,879.1, linear $5,178.2
- Working-tree `models/price_predictor.joblib` → v`20260704_1424`, XGB $2,795.4, linear $4,815.7

Run `20260617_0328` was a transient high-water mark. It was overwritten by the 2026-07-04
retrain and no longer corresponds to any deployed or stored model.

## 7. Validation scheme

**A single 80/20 holdout split produces every reported metric** (`ml/pipeline.py:360-362`).
There is no cross-validation of the final selected model.

K-fold appears three times, all *inside* training, none for reported metrics:
1. `ml/pipeline.py:446-455` — `GridSearchCV(..., cv=5)` for XGB hyperparameters, fit on `X_train` only (`:455`)
2. `ml/pipeline.py:305-316` — `KFold(n_splits=5)` for leakage-free cohort target encoding
3. `ml/pipeline.py:88-94` — `LassoCV(cv=5)` inside `RelaxedLasso`

**Was tuning done on the split the metrics come from?**

*Hyperparameter tuning: no.* `GridSearchCV` fits on `X_train` with internal 5-fold CV
(`:455`), and early stopping carves its validation slice out of `X_train`
(`:466-468`). The test set is untouched by both. This part is clean.

*But two operations do touch the test split:*

**(a) Model selection — `ml/pipeline.py:614`:**
```python
best_name = min(metrics.keys(), key=lambda k: metrics[k]["mae"])
```
`metrics[k]["mae"]` is test-set MAE (`:563-565`). The winner is chosen by the same
number that is then reported as the headline result. With four candidates this is
mild, but the reported MAE is selection-optimistic — it is a best-of-four minimum,
not an unbiased estimate.

**(b) Calibration — `ml/pipeline.py:626-627`:**
```python
test_log_preds = pipe.predict(X_test)
log_calibration = float(np.median(test_log_preds - y_test_log.to_numpy()))
```
The calibration offset shipped in the model payload (`:666`) and applied to every
production prediction (`:791`, `api.py:354`) is **fitted on the held-out test set.**
This does not contaminate the reported MAE — that is computed before calibration at
`:563` — but it means the test set is not truly held out with respect to the deployed
artifact. The README documents this openly rather than hiding it
(`TECHNICAL_README.md:171`, `:524-528`).

The committed README also concedes the split limitation
(`TECHNICAL_README.md`, §16.6): *"All reported MAE figures come from a single 80/20
split... The variance between runs on the same dataset... is $150–400 in MAE."*
That variance band ($150–400) is **wider than the $2,753 → $2,795 difference** between
the claimed figure and the shipped model.

## 8. The four benchmarked models

All four are constructed in `ml/pipeline.py:409-512` and trained/evaluated in one loop
(`:525-590`).

| # | Key | Class | Library | Location |
|---|---|---|---|---|
| 1 | `linear` | `LinearRegression` | scikit-learn | `ml/pipeline.py:410` (import `:10`) |
| 2 | `relaxed_lasso` | `RelaxedLasso` (custom) | custom, wrapping scikit-learn `LassoCV` + `LinearRegression` | `ml/pipeline.py:411`; class at `:29-141` |
| 3 | `rf` | `RandomForestRegressor` | scikit-learn | `ml/pipeline.py:412-417` (import `:11`) |
| 4 | `xgb` | `XGBRegressor` | **xgboost** | `ml/pipeline.py:499-512` (import `:17`) |

All four MAEs are persisted per run (`scheduler/runner.py:60-63`), so the benchmark is
auditable — the committed `logs/training_log.csv` carries `linear_mae`,
`relaxed_lasso_mae`, `rf_mae`, `xgb_mae` columns.

**Two caveats:**

- **XGBoost is conditional.** `ml/pipeline.py:420` — `if HAS_XGB:`. If the import at
  `:17` fails, only **three** models are benchmarked. The fallback
  `GradientBoostingRegressor` is imported at `:22` but **never added to `candidates`** —
  a latent bug: on a machine without xgboost the benchmark silently shrinks to three
  and the fallback import is dead code.
- **`relaxed_lasso` was added late.** It is absent (empty column) from the first seven
  runs in the committed log — runs before `2026-04-28 03:10` benchmarked only three models.

## 9. Log-transformed target and dollar-space metrics

**Both confirmed.**

*Training on log target* — `ml/pipeline.py:369-370`:
```python
y_train_log = np.log1p(y_train)
y_test_log = np.log1p(y_test)
```
Every candidate is fit against it — `ml/pipeline.py:531`: `pipe.fit(X_train, y_train_log)`.

*Metrics in dollar space* — `ml/pipeline.py:563-565`:
```python
pred_test = np.expm1(pipe.predict(X_test))
y_true = y_test.to_numpy()
mae, rmse = _eval(y_true, pred_test)
```
Predictions are inverted with `expm1` and compared against raw dollar prices.
`_eval` (`:514-517`) is a plain `mean_absolute_error`. The reported MAE/RMSE,
luxury/non-luxury slices (`:572-573`) and tier table (`:607`) are all in dollars.
Inference does the same inversion (`:791`, `api.py:354`).

**Three log-space residues to be aware of:**
- `train_rmse_log` (`:560`) is in log space and is logged alongside dollar metrics.
- Grid search optimises `neg_mean_absolute_error` against `y_train_log` (`:450`, `:455`) — MAE in *log* space.
- The XGB objective is `reg:absoluteerror` (`:435`) — also log space.

So the model is *selected and tuned* on log-space error but *reported* in dollars. The
reporting claim is accurate; the two spaces are not interchangeable for tuning claims.

## 10. Is SQLite queried with SQL?

**Yes — real SQL via the SQLAlchemy ORM, not a dataframe dump.** But the picture is mixed.

The most non-trivial query is `get_top_deals` — `db/repository.py:186-197`:

```python
results = (
    self.session.query(CarListing, Prediction)
    .join(Prediction, CarListing.listing_id == Prediction.listing_id)
    .filter(
        CarListing.is_active == True,
        Prediction.deal_score.isnot(None),
        Prediction.deal_score >= min_deal_score,
    )
    .order_by(Prediction.deal_score.desc())
    .limit(limit)
    .all()
)
```

A two-table inner join on `listing_id` with three predicates, a sort, and a limit —
compiled to SQL and executed in SQLite. Also genuine SQL:
- `db/repository.py:131-135` — `func.count(CarListing.id)` with a filter (SQL `COUNT`)
- `db/repository.py:226`, `:230` — `func.max(PopularitySnapshot.snapshot_date)` (SQL `MAX`)
- `db/repository.py:119-122` — date-predicate filter on `first_seen`
- `db/repository.py:104-112` — four-predicate filtered select

No raw SQL strings exist (grep for `text(`, `.execute(`, `read_sql` returns only JSON
file I/O in `scraper/`). All SQL is ORM-generated.

**The qualification:** `get_active_listings_df` (`db/repository.py:102-117`) does pull
the whole filtered table into a DataFrame, and the API then does its real work in
pandas — `api.py:97-113` performs the make/model/body filtering and sorting in pandas
*after* fetching up to 5,000+ joined rows (`api.py:82`). Aggregation for the popularity
snapshot is likewise pandas `groupby`, not SQL `GROUP BY`
(`ml/pipeline.py:826-837`). So: SQL for the join, filter, sort and count; pandas for
most downstream aggregation and the user-facing filters.

## 11. Does the React dashboard run, and is the model live?

**It runs — verified, not inferred.**

- Production build succeeds: `npx react-scripts build` → `68.06 kB` gzipped
  `build/static/js/main.4b9375f3.js`, exit 0.
- Flask API starts (`PYTHONPATH=. python api.py`, `api.py:361-364`) and serves live requests.

Verified responses:

| Endpoint | Result |
|---|---|
| `GET /api/stats` | `{"active_listings": 11471, "makes": 54, "models": 635, "avg_price": 28369.08, ...}` |
| `GET /api/deals?limit=10000` | 10,000 rows returned |
| `GET /api/predict?make=toyota&model=camry&year=2020&mileage=50000` | `{"predicted_price": 25205.0}` |

**It does both — and the distinction matters for the ranking claim.**

*Precomputed (the ranked deal list):* `/api/deals` (`api.py:60-137`) calls
`repo.get_top_deals()` (`api.py:82`), which reads the `predictions` table. Those rows
are written offline by `score_job` (`scheduler/runner.py:113-124`) →
`pipeline.score_listings` (`ml/pipeline.py:761-819`). All 11,471 prediction rows in the
DB carry a single `model_version`, `20260704_1424` — one batch, written at scoring time.
The dashboard's main view reads a table; it does not invoke the model.

*Live (the price estimator):* `/api/predict` (`api.py:315-358`) loads the joblib
per request (`api.py:334`), builds features, and calls `payload["model"].predict(X)`
at request time (`api.py:354`). The frontend hits it from the PRICE CHECK view
(`frontend/src/car-intel-dashboard.jsx:447`).

The frontend requests `${API}/deals?limit=10000&min_score=0`
(`frontend/src/car-intel-dashboard.jsx:138`) against
`http://localhost:5001/api` by default (`frontend/src/car-intel-dashboard.jsx:7`).

---

# CONTRADICTIONS

Things the four resume bullets could not defend.

## "ranks 10,000+ used car listings against predicted fair value"

1. **Not true of the committed repo.** HEAD holds 8,415 raw listings and 7,731 after the
   modelling filters. The largest `total_active` in the committed `logs/scrape_log.csv`
   is 8,415. The claim is supported only by uncommitted working-tree state
   (11,471 raw / 10,486 modelling). If a reviewer clones the repo, they find 8,415.
2. **"Listings" is cumulative, not current.** `mark_inactive`
   (`db/repository.py:86-100`) is **never called anywhere** — verified by grep. `is_active`
   is therefore never set to 0, and all 11,471 rows carry `is_active=1`. The count
   includes every listing ever ingested since April, sold or not. It is not 10,000+
   *available* cars.
3. **The delivered ranking is capped below the claim.** The UI requests `limit=10000`
   (`frontend/src/car-intel-dashboard.jsx:138`) and the endpoint truncates with
   `.head(limit)` (`api.py:113`) — the live response returned exactly 10,000 rows,
   not 11,471.
4. **The modelling dataset is smaller than the ranked set.** The model is *trained* on
   10,486 rows but 11,471 are scored — the 985-row difference is stale listings
   (`days_listed > 365`) deliberately excluded from training (`ml/pipeline.py:347-348`)
   yet still ranked. Defensible design, but "10,000+ listings" conflates two different
   numbers.

**Defensible narrower version:** "ranks ~11,000 ingested listings, trained on ~10,500."

## "~8% median error in the mainstream $20-35k segment"

1. **It is not a median.** `ml/pipeline.py:609` computes
   `_tier_mae / _tier_mean * 100` — bucket MAE divided by bucket mean price. That is a
   ratio of two aggregates. No per-listing error distribution is formed, so nothing is
   ranked and no median is taken. The word "median" describes a statistic the codebase
   never computes.
2. **It tracks the mean, and the real median is far better.** Reproduced on the held-out
   split: $20–35k median APE = **3.9%**, mean APE = **7.4%**, pipeline ratio = **7.4%**.
   The quoted 8% matches the *mean*. The bullet mislabels the statistic while
   simultaneously *understating* the median.
3. **The figure is absent from the committed repo.** The measured per-tier table exists
   only in uncommitted `TECHNICAL_README.md:630`. The committed
   `TECHNICAL_README.md:627-629` puts a $20,000 car at **~14%** and only reaches 8% at
   $35,000, by dividing overall MAE by a round price — a method the uncommitted README
   itself calls "wrong" (`:636`).
4. **The figure is never persisted.** It is a `logger.info` line
   (`ml/pipeline.py:611`) written to stdout. It is not in `logs/training_log.csv`
   (`scheduler/runner.py:52-71`) and not in the model payload
   (`ml/pipeline.py:661-668`). There is no committed output file to point at.
5. **Its source run no longer exists.** The table comes from run `20260617_0328`,
   which was superseded by the 2026-07-04 retrain. Neither the committed model
   (v`20260506_0615`) nor the working-tree model (v`20260704_1424`) is that run.

**Defensible narrower version:** "~7% mean absolute percentage error (3.9% median) in
the $20–35k band, on a single held-out split."

## "selecting XGBoost from four benchmarked models"

This is the **best-supported bullet** — but three qualifications.

1. **Selection happens on the reported test split.** `ml/pipeline.py:614` picks the
   winner by `metrics[k]["mae"]`, which is test-set MAE from `:563-565`. The headline
   MAE is thus a best-of-four minimum on the same data used to choose the winner —
   optimistically biased, and not a clean holdout estimate.
2. **XGBoost was not always selected.** The committed `logs/training_log.csv` row
   `2026-04-28 03:10` records `selected_model=relaxed_lasso` (MAE 2,832 vs XGB 2,864).
   Selection is data-dependent, not a fixed conclusion. The README's stronger claim —
   "XGBoost is always selected as the production model"
   (`TECHNICAL_README.md:382`) — is contradicted by the repo's own committed log.
3. **"Four" is conditional.** `ml/pipeline.py:420` gates XGB behind `if HAS_XGB:`, and
   the `GradientBoostingRegressor` fallback imported at `:22` is never added to
   `candidates` — so an environment without xgboost benchmarks three, not four.
   Separately, the first seven committed runs predate `relaxed_lasso` and benchmarked
   only three.

## "training in log space so error scaled with vehicle value"

1. **The mechanism is real; the stated effect is not achieved.** Log training is
   confirmed (`ml/pipeline.py:369-370`, `:531`). But "error scaled with vehicle value"
   asserts roughly constant *percentage* error. Measured on the held-out split, percentage
   error is **U-shaped, varying by 2.8×**:

   | <$10k | $10–20k | $20–35k | $35–60k | >$60k |
   |---|---|---|---|---|
   | 20.6% | 13.3% | **7.4%** | 9.1% | 10.4% |

   Errors do not scale with value. They are worst at both extremes and best in the middle.
2. **The repo says so itself.** `TECHNICAL_README.md` §16.1 opens by calling the error
   "heteroscedastic — the error is not uniform across price tiers," and the uncommitted
   version (`:634`) describes the percentage error as explicitly "U-shaped." The bullet
   claims the opposite of what the repo's own limitations section documents.
3. **Tuning is log-space, reporting is dollar-space.** Grid search scores
   `neg_mean_absolute_error` on `y_train_log` (`ml/pipeline.py:450`) and the XGB
   objective is `reg:absoluteerror` in log space (`:435`), while reported metrics are
   dollars (`:563`). Accurate as stated, but the two spaces should not be conflated when
   describing what was optimised.

**Defensible narrower version:** "trained on a log-transformed target to penalise
proportional rather than absolute error, with metrics reported in dollar space."

---

## Cross-cutting findings

- **Every headline number is uncommitted.** Nothing at HEAD supports $2,753, $4,908,
  10,000+ listings, or 8%. A reviewer cloning `main` finds 8,415 listings, a model
  scoring $2,879, and a README whose tier table is illustrative arithmetic. Committing
  the working tree would resolve most of this.
- **Calibration is fit on the test set** (`ml/pipeline.py:626-627`) and ships in the
  deployed artifact (`:666`, applied `:791`). The reported MAE is unaffected (computed
  at `:563`, before calibration), but the held-out set is not clean with respect to the
  production model.
- **Run-to-run variance exceeds the claimed improvement.** The README states $150–400
  MAE variance from split noise alone (§16.6). The gap between the claimed $2,753 and
  the shipped $2,795 is $42 — inside the noise. Quoting $2,753 as *the* model's accuracy
  is quoting the best draw.
- **Dead code that misleads on provenance.** `mark_inactive`'s `scrape_source="cars.com"`
  default (`db/repository.py:86`) is the only cars.com reference in the repo and the
  function is never called. It should be deleted — it is the single artifact that could
  make a reader believe HTML scraping occurred.
