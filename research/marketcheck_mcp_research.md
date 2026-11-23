# Using MarketCheck's other endpoints on the free plan

Run date 2026-11-23. Question: how can MarketCheck's API improve price-model accuracy, coverage of cars we cannot rate, specs and the "why this estimate" text, inside 500 calls a month when the nightly scrape already uses about 15 a day (about 450 a month, leaving about 50). I read `ml/pipeline.py` (cohort code), `scraper/data_ingest.py` (`map_listing`), `research/model_improvement_research.md`, `free_fields_research.md` and `weak_spots_research.md`, and did not repeat them. I called no MarketCheck API or MCP tool. "Observed 2026-11-23" means a result the owner got through the MCP server today; I did not reproduce it. "Silent" means the docs do not say. One DB check was a read-only SELECT.

## Answer first

1. **A terms problem comes before any new endpoint.** The Terms of Service (last updated Oct 20, 2026) bar training, fine-tuning, evaluating or building any AI model from MarketCheck data without a separate signed agreement (§6.1), and bar caching or database mirrors of API responses beyond one end-user request (§7.1). Our pipeline stores listings in SQLite and trains on them. The Acceptable Use Policy adds that the free tier is "for evaluation and development only" and cannot be a production data source (§2.3). [Terms](https://developers.marketcheck.com/terms), [Acceptable Use](https://developers.marketcheck.com/acceptable-use). This applies to the existing scrape too, not only to the proposals. The owner should read the Terms and decide; I am not a lawyer, and my reading comes from a page-summarising fetch, not the raw text, so check §6 and §7 directly (api@marketcheck.com is the contact the Terms give for AI training).
2. **Call cost on Free is not documented per endpoint.** Free is "500 calls a month with no per-call charges, and calls stop at the cap" ([developers pricing](https://developers.marketcheck.com/pricing)). Every endpoint page says "priced per call" and gives no amount. Whether a Price, Decode or Recents request counts as 1 of the 500 or more is silent. Assume 1 each, and measure the counter after the first use of each (see Open questions).
3. **Best fits for about 50 calls a month:** capture `msrp` from the calls we already make (0 extra calls), a national stats call for cold-start cohorts (about 35 calls), and a small `marketcheck_price` audit (about 10 calls).
4. **Sold data is a weak fit.** "Sold" is inferred, and its price is the last asking price, not a transaction price. It needs a location on every call and costs more per call on paid plans.

## 1. Cost, limits and plan

| Item | Documented | Source |
|---|---|---|
| Free plan | 500 calls a month, 5 calls a second, 100-mile radius, 500-row pagination, no third-party APIs, calls stop at the cap (no overage) | [marketcheck.com/pricing](https://marketcheck.com/pricing), [developers pricing](https://developers.marketcheck.com/pricing) |
| Which endpoints Free includes | Silent. The pricing pages label nothing "premium". Basic ($299 a month plus data fees, 5,000 calls, 1,500-row pagination) says "access to every API endpoint" | same |
| MCP calls | "count against the same plan" as the API key | [MCP](https://developers.marketcheck.com/mcp) |
| Per-call prices (paid plans only) | The pricing page lists Inventory Search $0.002, Past Inventory $0.0025, History $0.006, MarketCheck Price $0.07, NeoVIN $0.08. The machine-readable feed lists different numbers (search $0.008, past 90 days $0.018, history $0.018, price $0.14 to $0.26, NeoVIN $0.16) and labels them `starter_payg`. The two sources disagree and neither says which applies to Free | [pricing](https://marketcheck.com/pricing), [acp-feed.json](https://developers.marketcheck.com/acp-feed.json) |
| Ratio inside the feed | Recents and history are about 2.25 times a search, price about 17 to 32 times, NeoVIN 20 times. This is a price ratio, not a quota ratio | acp-feed.json |
| Sold Summary | Not listed for Free. It returned 403 today. The docs say "Free includes 500 calls" without naming endpoints | [market-trends](https://developers.marketcheck.com/apis/market-trends) |

The earlier note in `free_fields_research.md` recorded "5 calls a second" and "does not say which endpoints Free includes". Both still hold. The new fact is that the Terms and AUP restrict storage and model training.

## 2. Request features: more data per call

| Feature | Docs say | Source |
|---|---|---|
| Rows per call | `rows` max 50, default 10, above 50 falls back to the default. Max page is 10,000 divided by `rows`, and the plan limits how far you can paginate. Out-of-range returns 422 | [Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search.md) |
| `rows=0` | The examples use `rows=0` for stats/facets-only requests. No prose rule. Observed 2026-11-23 that one call returned counts and percentiles | same |
| `stats=` | Numeric fields: price, msrp, miles, highway_mpg, city_mpg, dom, dom_180, dom_active, dos_active (and loan/lease fields). Returns mean, max, min, count (percentiles observed 2026-11-23 on this account, not on the page) | same |
| `facets=` | About 45 fields incl. make, model, state, body_type, high_value_features. Format `field\|offset\|limit\|min_count`, limit default 20, max 1000 | same |
| `range_facets=` | Named, no further detail read | same |
| `vins=` | "Comma-separated list of VINs", used with `match` to "find similar cars around" those VINs. No batch limit stated (the 10-per-request figure in the task brief is not on the page). Invalid VINs are dropped. It finds similar cars, so it may not be a lookup by VIN | same |
| `fields=` | Not documented on the search page. It is documented on the History endpoint ("repeat any defaults you still need") | search page, [VIN history](https://developers.marketcheck.com/apis/vin-history) |
| `include_build_object` | Not documented on the pages I fetched | search page |
| Past-90-days | One facet, stats or range-facet field per request. Every request needs a location or dealer. Max rows silent | [past inventory](https://developers.marketcheck.com/apis/past-inventory-search) |
| History | 50 rows a page, 422 past the end, no stated lookback limit | [VIN history](https://developers.marketcheck.com/apis/vin-history) |

The search page fetch was a truncated summary. Treat "not documented" for `fields` and `include_build_object` as "not found in what I read".

## 3. Fields we do not use

`map_listing` stores year/make/model/trim, body type, price, miles, dealer name/type/phone/street, transmission, drivetrain, fuel, powertrain, engine size, cylinders, doors, seats, MPG, `carfax_1_owner`, `ref_price`, `price_change_percent` and photos. It does not store `msrp`.

| Field | Meaning in the docs | Use |
|---|---|---|
| `msrp` (listing) | "Manufacturer's Suggested Retail Price (as per dealer website)"; the definitions page says base price without dealer options ([definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)). Fill rate on used listings unmeasured | Level feature (not price/msrp ratio). Free, 0 extra calls, going-forward only |
| `combined_msrp`, option packages with codes and msrp | NeoVIN returns `msrp` (base) and `combined_msrp` (as configured); the options-packages endpoint gives code, name, msrp per package ([NeoVIN](https://developers.marketcheck.com/apis/neovin-decoder)). The page does not mention hp, torque, 0-60 or weight, although the owner observed them 2026-11-23. Whether results cover used cars is silent | Per-VIN, so call-expensive. Only for a displayed car |
| `dom_active` | Days in the latest continuous listing across all sources; gaps of 30 days or more excluded. `dos_active` is one dealer site. `dom` is lifetime ([definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)) | Already stored per `weak_spots` and `free_fields`; keep out of price features (outcome of pricing) |
| `first_seen_at_mc` | "First seen at MarketCheck timestamp (Unix seconds)" | Same leakage rule |
| `carfax_1_owner`, `carfax_clean_title` | "if mentioned on dealer website". No reliability figure given | `carfax_1_owner` is stored; `carfax_clean_title` is not. Sparse, so low gain |
| `in_transit` | Filter, "typically in the new inventory type" | Not useful for a used-car model |
| `high_value_features`, `options_packages` | Search filters and facet fields; per-listing values not read | Facet counts could give feature-prevalence, unverified |

## 4. `marketcheck_price` and "sold"

- **How it is computed.** "Machine learning models trained on dealer retail data", one for the US and one for Canada, "using the last three months of that data and retrained weekly". Inputs: `vin`, `miles`, `dealer_type`, zip or city and state, optional `is_certified`; no condition input beyond miles. The docs state no accuracy or error figure. The comparables endpoint returns `num_found`, a `listings` array and notes that a for-sale car can appear in its own comparables ([marketcheck-price](https://developers.marketcheck.com/apis/marketcheck-price)).
- **Consequence.** It is trained on the same kind of data we use (asking prices of active dealer listings), so it is not an independent truth. Using it as a feature makes our model partly a copy of theirs, and a later "agree with MarketCheck" check would be circular. A small audit sample is sensible: it tells us where we differ, not who is right.
- **"Sold" in recents.** `sold=true` returns listings "inferred to be sold". A VIN counts once it has left active listings and none of its listings has been seen for a set period, currently seven days, "whether or not the dealer marks the car as sold". `price` is "the last listed price". Window is listings that ended in the last 90 days ([past inventory](https://developers.marketcheck.com/apis/past-inventory-search)). Sold Summary says the same: prices are asking prices, not transaction prices; city is the finest geography; monthly refresh ([market-trends](https://developers.marketcheck.com/apis/market-trends)).

## 5. Terms of use (summary of the fetched text)

- Display to your own end users in your own applications is allowed (§3.2); no resale, sublicensing, syndication or making data available to third parties (§5.1.1); no enabling end users to scrape or reconstitute it.
- Caching or storing beyond a single end-user request is prohibited, including persistent caches and database mirrors (§7.1). Only transient in-memory caching and minimal billing/audit/support records are allowed (§7.2, §7.3). Enterprise may negotiate caching or bulk terms (§7.4). On termination you must purge MarketCheck data (§9.3).
- No model training, fine-tuning, evaluation, distillation, RAG corpora or synthetic data without a signed written agreement (§6.1). In-context use in a real-time session without persisting is allowed (§6.1(f)).
- You acquire no ownership in "any derivative aggregate, index, ranking" (§4.1). Attribution ("Data powered by MarketCheck") is required only on request (§8.1).
- Free tier is for evaluation and development only (AUP §2.3). Multiple accounts or rotating IPs to get around limits are banned (AUP §2.2).
- Checked against the raw page text on 2026-11-23: the training ban is also stated in §5.1.2, the no-offline-copy rule in §5.1.4, the caching ban in §7.1 and the free-tier limit in AUP §2.3, in the words summarised here.
- Originally read through summaries, not the raw text. I saw model summaries of the Terms and AUP. Whether a trained model's weights or a stored price estimate count as "derived" is for the owner or MarketCheck to answer.

## 6. Proposals, ranked

Budget: about 50 spare calls a month. Arithmetic assumes 1 call = 1 unit on Free (unconfirmed). All gains are unmeasured guesses. Every proposal below that stores responses meets the §7 issue above; a no-storage version is noted where it exists.

### Fits in the leftover ~50 calls a month

| # | Proposal | Improves | Calls a month | File that changes | Risk |
|---|---|---|---|---|---|
| 1 | Store listing `msrp` from the search calls already made, then add it as a level feature | Price accuracy, trim/option level that `trim` hides | 0 extra | `scraper/data_ingest.py` (`map_listing`), `db/models.py`, `ml/pipeline.py` | Fill rate on used cars is unknown (check one raw page first). Dealer-entered, may be 0 or stale. Going-forward only. Medium leakage risk per `free_fields_research.md` |
| 2 | National stats call per cold-start cohort: `rows=0`, `stats=price,miles,dom_active`, filtered to one make/model/year, nationwide | Coverage: cars with 0 to 2 comparables get a market median and count, so some can be rated or at least explained | 35. Of 4,247 active make/model/year groups, 1,568 (37%) have only one dealer in our data. At 35 a month that is about 45 months to cover them. Prioritise groups with the most listings. Per-year counts for a whole model come from one call, so group by model first | New `scraper` helper, a small table, `ml/pipeline.py` fallback when `cohort_count` is low, `api.py` text | National counts are all dealers' asking prices, but we price a local car, so the median ignores region. Storage conflicts with §7. 100-mile radius on Free was not hit nationally (observed 2026-11-23), docs silent on why |
| 3 | `marketcheck_price/comparables` audit on a sample of rated cars (including a few "Not rated") | Finds systematic gaps (trims, regions); comparable listings can improve the "why" text | 10 (10 cars, one call each) | A one-off script, nothing in the pipeline | Circular if used as a target. Dealer type must be passed correctly. Do not store results (§7) |
| 4 | Listing history for the few cars a user opens or the top deals | "Why": relist count, prior dealers, price path back to 2024 | Up to 5 | `api.py` (on-demand), frontend explanation | We already store `ref_price` and `price_change_percent`; the new value is cross-dealer history. Cannot be cached |
| 5 | NeoVIN decode for the displayed hp, 0-60 and `combined_msrp` of a car | Specs where vPIC has none (hp is NULL on about 41% of squishes per `weak_spots_research.md`) | 0 to 5 | `scraper/vehicle_specs.py` | Docs do not list hp/torque/0-60, only observed. Per-VIN, so no coverage at this budget. Not a fix for the 41% |

Suggested split: 35 for #2, 10 for #3 in the first month, 5 reserve. After the first month, drop #3 and spend it on #2 or #4. Check the daily counter in `data/api_usage.json` before each run, since the 15 a day can drift.

### Needs a paid plan or an agreement

| # | Proposal | Why it needs one |
|---|---|---|
| 6 | Sold listings (`search_past_90_days`, `sold=true`) as calibration: days-to-sell and last asking price by segment | Needs location on every call, row cap silent, and the price is still an asking price. At 50 rows a call, even 50 calls is 2,500 rows. Use is more useful per state than at the volume of the free tier. Training on it needs the §6.1 agreement |
| 7 | Sold Summary (monthly sold counts, price quartiles, median `dom_active` by make/model/city) | 403 on Free. Basic says "every API endpoint". Gives market-level days to sell, which would feed "why this price" and rating of thin cohorts. Same asking-price caveat |
| 8 | Bulk or cached pull of MarketCheck data for training and storage | §6.1 and §7.4 require a written agreement. Basic is $299 a month plus fees for 5,000 calls and 1,500-row pagination, but the plan page does not grant the right to train or store |
| 9 | `marketcheck_price` as a model feature | Price tiers $0.07 to $0.26 per VIN on paid plans, 29,513 active listings is far past Free. Also circular (section 4) and a model-input use that §6 may restrict. Not recommended |
| 10 | `vins=` batching | Not a paid issue. On Free the doc is silent on batch size and describes "similar cars", so it may not be a VIN lookup. Test one call only after the counter is understood |

## 7. Open questions the docs left unanswered

1. How many of the 500 units each endpoint consumes on Free (Recents, Price, Decode, History, a `rows=0` stats call, a call with `facets` and `stats` together). Test: note `api_usage.json` before and after one call per endpoint, and check the MarketCheck dashboard if it shows usage.
2. Whether the free-plan data-fee schedule differs from the two public ones (they disagree by about 4x on search).
3. Whether Free may use Price, Decode, History and Recents at all. They worked today (observed 2026-11-23), but the pricing pages never promise it. Sold Summary is blocked.
4. The `vins=` batch limit, and whether it returns those VINs or similar cars.
5. Whether `fields=` and `include_build_object` exist on the search endpoint.
6. The maximum `rows` for recents, and whether a stats call can be national on Free while other calls are held to 100 miles.
7. How well `marketcheck_price` performs: the docs give no accuracy, bias or coverage figure.
8. Whether a model trained on stored MarketCheck listings, and its outputs, fall under Terms §6.1, §7 and §4.1. If the answer is yes, the existing pipeline needs an agreement or a redesign before any of the above matters.
9. Fill rate of `msrp` on used listings, and what `high_value_features` and options look like per listing. Needs one real response; the repo has no saved raw payload (`logs/` was not opened).

Pages that could not be read in full: the search page was truncated in the fetch, the Terms and AUP were read through summaries, and the Cost Estimator and Data Fee Schedule links were not followed. `docs.marketcheck.com` pages were fetched as `.md` where the `llms.txt` index listed one.

## MSRP feature: status

`CarListing.msrp` is now stored (scraper/data_ingest.py `map_listing`; null if missing or <= 0) but is NOT a model feature, and the live DB has none yet (it fills as listings are re-seen).

Fill rate in `logs/marketcheck_sample.json` (one search, 50 used listings, 2026-11-23): `msrp` present on 40 of 50 (80%), all positive. In all 40 (100%) it equals the asking price exactly, so on used cars it is the price echoed back and would leak the target. One sample of one search, so the true share elsewhere is unknown.

Experiment once coverage exists: re-scrape, count rows where `msrp != price`, then compare holdout MAE/MAPE (same VIN-grouped split) for the current features vs. current + `msrp` (and `msrp / price`-free variants such as `msrp - price` excluded), restricted to rows where `msrp != price`. Rows with `msrp == price` must be dropped or set to null, not used as-is. Ship only if the gain holds on that subset.
