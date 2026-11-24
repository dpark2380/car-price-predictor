# Market API (dev, 2026-11-24)

Backend for the Market pages. All endpoints are GET, JSON, read-only, cached in memory until the pipeline next writes `car_intel.db` (same `db_cached` / `_db_version` mechanism as `/api/deals`). Errors are `{"error": "..."}` with 400/404. Examples are trimmed (`...`) from real responses on the dev database, 2026-11-24.

**One rule for every aggregate.** A car is counted once: the newest active row per VIN (`last_seen`, then `id`), asking price at or above $3,000, joined to its prediction. That gives 23,112 cars from 29,513 active rows (the pipeline does not mark a superseded row inactive when a dealer's price cut re-lists the VIN, so active rows hold duplicates; the aggregates de-duplicate, nothing else was changed). Code: `market.py`; routes in `api.py`.

**Grades** use the frontend tiers (`frontend/src/utils/scoreColor.js`), from `deal_score` alone: `great` >= 90, `good` 65-90, `fair` 35-65, `high` 15-35, `over` < 15, `nr` (not rated) = `deal_score` null. Cars rated from US-wide stats (`rating_basis: "national"`) have a score, so they get a tier and are not `nr`, as on the listing pills.

**Gap %** = (model estimate - asking) / estimate x 100: positive means listed below the estimate, negative above. Medians include unrated cars (their estimate is unverified, but it is the only one).

Matching of `<make>` and `<model>` is case-insensitive against stored values; the response carries the stored spelling. Unknown make or model: 404.

---

## GET /api/market/makes

Every make, sorted by `n` descending (51 today).

```json
[{"make": "Toyota", "n": 2712, "median_price": 26602, "median_gap_pct": -0.1, "median_dom": 81},
 {"make": "Ford",   "n": 2710, "median_price": 22988, "median_gap_pct": -0.7, "median_dom": 139}]
```

- `median_price`: dollars, integer. `median_gap_pct`: percent, one decimal, null if no estimate. `median_dom`: days, integer, from `days_listed` (MarketCheck `dom`, total days on market as of the last scrape), null if unknown.
- A make with one car is returned as is (`{"make": "Rolls-Royce", "n": 1, ...}`); hide thin rows in the UI.

## GET /api/market/make/`<make>`

```json
{"make": "Ford",
 "summary": {"n": 2710, "models": 46, "median_price": 22988, "median_dom": 139},
 "models": [{"model": "F-150", "n": 1083, "p25": 17475, "p50": 25968, "p75": 36606,
             "median_gap_pct": -1.4, "median_dom": 143, "usual_error_pct": 5.8,
             "unrated": 9, "median_miles": 96424}, ...],
 "monthly": [{"model": "F-150", "months": [{"month": "2026-10", "n": 513, "p25": 17500, "p50": 25000, "p75": 36868},
                                            {"month": "2026-11", "n": 552, "p25": 17980, "p50": 26980, "p75": 36989}]}, ...]}
```

- `models`: every model, sorted by `n` descending. `p25/p50/p75`: asking price, dollars. `usual_error_pct`: median of `typical_error_pct` (the model's usual error for that car's price band and comparables), null if none. `unrated`: cars with a null `deal_score`.
- `monthly`: the 4 models with most cars (same order as `models`), each with months oldest first. Month = calendar month (UTC) of the car's current listing row's `first_seen` ("YYYY-MM"); `n` counts cars, once each. Months with a handful of cars are returned; the frontend fades thin ones (the mockup used 50).
- "Models" in `summary` merges spellings that differ only by case, so it can be one lower than a raw `COUNT(DISTINCT model)` (46 vs 47).

## GET /api/market/model/`<make>`/`<model>`

`<model>` may contain `/` (route is a path). Example `/api/market/model/ford/f-150`:

```json
{"make": "Ford", "model": "F-150",
 "summary": {"n": 1083, "price_p25": 17475, "price_p50": 25968, "price_p75": 36606,
             "median_miles": 96424, "dom_p25": 68, "dom_p50": 143, "dom_p75": 256},
 "by_year": [{"year": 2018, "n": 129, "p25": 19995, "p50": 23995, "p75": 29420}, ...],
 "histogram": [{"lo": 0, "n": 9}, {"lo": 5000, "n": 58}, {"lo": 10000, "n": 132}, ...],
 "dom_bands": [{"band": "0-30", "n": 107}, {"band": "31-60", "n": 123}, {"band": "61-90", "n": 145},
               {"band": "91-180", "n": 276}, {"band": "181-365", "n": 291}, {"band": "365+", "n": 141}],
 "price_changes": {"cut_n": 296, "median_cut_pct": 3.6, "raised_n": 38},
 "grades": {"great": 58, "good": 217, "fair": 435, "high": 181, "over": 183, "nr": 9},
 "monthly": [{"month": "2026-10", "n": 513, "p25": 17500, "p50": 25000, "p75": 36868}, ...],
 "points": [[2017, 111625, 21900, 3], [2026, 52, 63995, 4], ...],
 "points_total": 1083}
```

- `by_year`: every model year present, ascending (the mockup drew 2010 and later). `histogram`: contiguous $5,000 bins from `lo` 0 to the bin of the dearest car, empty bins included; bin `lo` covers `lo` to `lo + 4,999`. `dom_bands`: fixed six bands, in order, `365+` is more than 365 days; cars with unknown `days_listed` are in no band.
- `price_changes`: from the dealer's earlier price (`ref_price`) to the asking price, counting only believable changes (1-40% of the larger of the two prices; `db/price_history.py credible_change`). `cut_n`: cars cut; `median_cut_pct`: median size of a cut, percent of the earlier price; `raised_n`: cars raised. Share of cars cut = `cut_n / summary.n`. The mockup counted any `ref_price` above the price (346 cuts, 3.1%, 57 raised); the credible-drop rule gives fewer.
- `grades`: counts for the six tiers above; they add up to `summary.n`.
- `points`: at most 500 random cars as `[year, miles, price, grade]`; `grade` is 1 (over) to 5 (great), null when not rated. Fixed seed (42) on a stable order, so the same sample is returned between requests and until the data changes. `points_total` = cars in the model, to caption "500 of 1,083".
- Tiny models: everything that exists is returned (quartiles of one car equal that price); the frontend should hide charts under 30 cars.

## GET /api/car/`<vin>`

VIN is case-insensitive. 400 if not 17 letters/digits (no I, O, Q); 404 if it has no active listing. Uses the newest active row for the VIN. Example `/api/car/1FTEW1C55JKD85904`:

```json
{"vin": "1FTEW1C55JKD85904", "listing_id": "1FTEW1C55JKD85904-...", "url": "https://www.tc-tu.com/...", "photo_url": "https://...",
 "year": 2018, "make": "Ford", "model": "F-150", "trim": "XLT", "price": 24127.0, "mileage": 79591,
 "dealer_name": "Tucson Car & Truck Unlimited Llc", "location_city": "Tucson", "location_state": "AZ",
 "days_on_market": 319, "days_in_listing": 101, "first_listed": null, "first_seen": "2026-11-19",
 "deal_score": 59.0, "deal_label": "2 Stars", "rating_basis": null, "comparables": 69, "typical_error_pct": 5.76,
 "predicted_price": 25108.86, "model_number": 25108.86, "market": null,
 "history": [{"date": "2026-09-30", "price": 25782.0, "miles": 79591, "seller": "Tucson Car & Truck Unlimited Llc", "source": "scrape"},
             {"date": "2026-10-15", "price": 25064.0, ...}, {"date": "2026-10-29", "price": 24757.0, ...},
             {"date": "2026-11-05", "price": 25782.0, ...}, {"date": "2026-11-19", "price": 24127.0, ...}],
 "has_full_history": false,
 "cohort": {"n": 129, "p25": 19995, "p50": 23995, "p75": 29420, "prices": [8900, 12900, 12995, ...]}}
```

- Rating fields are as in `/api/deals`. `deal_label` is the stored label (old star wording); for the pill use the frontend tier of `deal_score`. All rating fields are null for a car with no prediction (under the $3,000 floor).
- `predicted_price`: the estimate for a car the model rated; the US median for `rating_basis: "national"`; null when unrated. **`model_number`: the model's raw estimate, always present when a prediction exists, including unrated cars** (the frontend marks it unverified when `deal_score` is null). Example, 2021 BMW M5 WBS83CH00MCH22911: `deal_score: null, deal_label: "Not rated", comparables: 0, predicted_price: null, model_number: 31808.95, price: 70245.0`.
- `market`: `{count, median, p25, p75}` US-wide asking prices for this make/model/year from `market_stats` (needs 5+ listings), else null. Today only 5 rows exist in the table, so it is null for almost every car (it is null for the M5; the mockup's US range came from live MarketCheck calls).
- `days_on_market` = MarketCheck `dom` (all listings of this car), `days_in_listing` = `dom_active` (current listing); either can be null. `first_listed`: date MarketCheck first saw the VIN (`first_seen_at_mc_date`, "YYYY-MM-DD"), **null until the nightly scrape re-sees the car after this change**; `first_seen` is when our scraper first stored this listing row.
- `history`: oldest first; `date` "YYYY-MM-DD"; `price` dollars; `miles` and `seller` can be null. `source` is `"scrape"` (our nightly search; a point is added when price or miles differ from the car's latest point), `"ref"` (the feed's earlier price and odometer, dated before our first point and 1-40% different from it; the date is the feed's `ref_price_dt`; only for cars the scraper has seen since this change) or `"marketcheck"` (steps from a stored `/api/history` result, merged in and dropped where we hold a point with the same price and miles within 3 days). One point means "we have seen this car once". The F-150 has 5 `scrape` points from 2026-09-30, from the back-fill.
- `has_full_history`: true once `/api/history?vin=` has stored a result for this VIN (then `marketcheck` points appear in `history`). The "Load full history" button calls `/api/history?vin=<vin>` (unchanged: one MarketCheck call a day, result stored for good, `{"available": false}` when capped); re-request `/api/car/<vin>` afterwards. Responses are cached until the database next changes, which that call does.
- `cohort`: asking prices of cars of the same make, model and year, one per VIN. `n` is all of them; `p25/p50/p75` are over all `n`; `prices` is sorted ascending and holds at most 400 (a seeded random sample when `n` > 400). The car itself is included.

## GET /api/model-card

404 `{"error": "no model card yet"}` when `models/model_card.json` is missing. Otherwise `{"card": <file>, "live": <database counts>}`.

`card` is written by `ml.pipeline.train` beside the model file at every retrain (`models/model_card.json`, git-ignored). It is computed on the **test split** (4,755 cars no model saw), for the selected model:

```json
{"date": "2026-11-23", "version": "20261123_1403", "selected_model": "blend",
 "rows": {"pool": 23775, "train": 15216, "val": 3804, "test": 4755},
 "candidates": {"linear": {"test_mae": 4278, "val_mae": 4416}, "relaxed_lasso": {...}, "rf": {...},
                "xgb": {"test_mae": 2833, "val_mae": 2858}, "blend": {"test_mae": 2743, "val_mae": 2782}},
 "test": {"n": 4755, "median_ape": 7.71, "ci95": [7.36, 8.01], "signed_median_pct": -0.07, "bias_pct": -0.07,
          "mae": 2743, "within5": 36.2, "within10": 59.2, "within20": 83.6,
          "by_price": [{"lo": 0, "hi": 10000, "n": 572, "median_ape": 15.39, "ci95": [13.87, 17.21], "signed_median_pct": 9.64,
                        "mae": 1503, "within5": 17.1, "within10": 33.0, "within20": 60.7}, ...],
          "by_comparables": [{"band": "0", "n": 530, "median_ape": 15.66, "ci95": [13.96, 17.04], ...},
                             {"band": "1-2", ...}, {"band": "3-9", ...}, {"band": "10-29", ...}, {"band": "30+", ...}]},
 "segment_errors": [{"lo": 0, "hi": 10000, "error_pct": 15.86, "n": 2371,
                     "cells": [{"comparables_lo": 0, "comparables_hi": 3, "error_pct": 16.44, "n": 1499}, ...]}, ...],
 "importance": {"base_val_mae": 2865, "rows": 1500, "repeats": 3,
                "groups": [{"group": "Comparables", "mae_added": 8638, "relative": 1.0},
                           {"group": "Age and mileage", "mae_added": 3298, "relative": 0.382},
                           {"group": "The car", "mae_added": 1618, "relative": 0.187},
                           {"group": "Location", "mae_added": 581, "relative": 0.067},
                           {"group": "Segment flags", "mae_added": 185, "relative": 0.021}]}}
```

- `date`/`version` are UTC. `candidates`: dollars, keys as the training log (`linear`, `relaxed_lasso`, `rf`, `xgb`, `blend`); `test_mae` is what the "Test error by model" bars show. The selected one is `selected_model`.
- `test.median_ape`: median absolute error as % of the true asking price; `ci95` its bootstrap 95% interval (2,000 resamples, seed 42); `signed_median_pct`: median of (estimate - price) / price, positive = over-estimates; `within5/10/20`: % of cars within that error; `mae`: dollars. `by_price` bands are by true price (`hi` null = open); `by_comparables` bands count other-dealer cars of the same make/model/year in the training split. Bands under 2 cars have no `ci95`.
- `segment_errors`: the deal score's yardstick, as the training log prints it: median absolute % error per price band (`error_pct`), and per comparables cell (`comparables_lo` inclusive, `comparables_hi` exclusive, null = open: 0-2, 3-9, 10+), measured on the validation split plus out-of-fold errors of the training cars (so `n` totals about 19,000, not 4,755). Order: bands ascending; the mockup's "All" column is `error_pct`.
- `importance`: permutation importance on 1,500 validation cars: each group's columns are shuffled together (3 repeats) and `mae_added` is the mean rise in validation MAE in dollars. `relative` is `mae_added` over the largest (use as bar width). Groups come in a fixed order (Comparables, Age and mileage, The car, Segment flags, Location), not by size; sort in the UI. Correlated inputs share credit, so read it as "how much the model leans on this group", not a causal effect.

`live` is computed from the database now:

```json
{"cars_listed": 23112,
 "grades": {"great": 489, "good": 3951, "fair": 11087, "high": 3016, "over": 1727, "nr": 2842},
 "not_rated": {"no_comparables": 2472, "thin_extreme_score": 370, "unknown": 0, "rated_from_national": 69},
 "gap_by_comparables": [{"band": "0", "n": 2541, "median_abs_gap_pct": 14.5}, {"band": "1-2", "n": 4037, "median_abs_gap_pct": 10.5},
                        {"band": "3-9", "n": 7972, "median_abs_gap_pct": 7.9}, {"band": "10-29", "n": 5633, "median_abs_gap_pct": 6.1},
                        {"band": "30+", "n": 2929, "median_abs_gap_pct": 6.1}]}
```

- `grades` sums to `cars_listed`. `not_rated` explains `grades.nr`: `no_comparables` (0 comparables) + `thin_extreme_score` (1-2 comparables and a top or bottom score) + `unknown` = `nr`; `rated_from_national` is a separate count of cars that have a rough US-based score (they are in the other tiers). The mockup folded those 69 into "no comparables" (2,541 = 2,472 + 69) and showed 2,911 not rated; this page shows 2,842 so it agrees with the site's pills.
- `gap_by_comparables`: median of |gap %| (estimate-based, see top) for the cars in each band of `comparables`, rated or not.

## Existing endpoints used

- `GET /api/history?vin=` unchanged. Its stored result (`vin_history`) now also feeds `/api/car` `history`.

## Data notes

- `vin_price_history` (new table): `vin, date (UTC), price, miles, seller, source`. `price_history` (one row per listing id, never more than one per listing) is left as it was; nothing but one test reads it.
- New `car_listings` columns, filled by the scrape from now on: `ref_price_dt`, `ref_miles`, `ref_miles_dt`, `first_seen_at_mc_date`, `first_seen_at_source_date`. Feed formats: `ref_price_dt`/`ref_miles_dt` are epoch seconds, the `first_seen_at_*_date` fields ISO text with `Z`. They are NULL on every existing row until the car is re-seen.
- One-off, idempotent: `PYTHONPATH=. python3 scripts/backfill_price_history.py [--dry-run]`. Run it once before the first nightly scrape that writes history; a scrape that ran first leaves a duplicate point for the cars it saw.
