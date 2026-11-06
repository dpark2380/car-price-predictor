# Deal detection: how to improve it and how to prove it works

Run date 2026-10-31. Scope: the deal flag (`deal_score`, 4+ stars = score >= 75) has no ground-truth labels, and flagged cars are older listings. I read `model_research.md`, `model_improvement_research.md` (esp. "Dealer warning") and `model_algorithms_research.md`, and do not repeat them (conformal intervals, dealer-neutral scoring, LODO comps are covered there). I read `ml/pipeline.py:924` (`_deal_score_from_prices`), `scraper/data_ingest.py` (field mapping), `db/models.py`, and ran read-only queries on `car_intel.db` (`mode=ro`). No repo code, DB, models or logs were changed. No Marketcheck API calls were made.

Source rule: every claim has a link. "Unverified" means I could not open a primary source this session, or only saw a bibliographic record. Industry blog numbers (iSeeCars, CarGurus) are not used as evidence.

## Answer first: does Marketcheck give us ground truth?

Yes, partly, and the cheapest part is free. All field names below come from Marketcheck's official docs.

1. **Fields we already receive and drop (0 extra calls).** The active-search listing object documents `dom` (lifetime), `dom_180`, `dom_active`, `dos_active`, `price_change_percent`, `ref_price`, `ref_price_dt`, `ref_miles`, `first_seen_at`, `last_seen_at`, `first_seen_at_source`, `first_seen_at_mc` ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). `scraper/data_ingest.py:213` stores only `dom` (as `days_listed`). `ref_price` is documented as "Previously listed price at same source for reference" and `price_change_percent` as "Price change percentage from reference price". That is a price-cut label on every listing, in the response we already pay for. Unverified: whether the free plan's real responses populate these fields (docs do not say; we keep no raw payloads, and a grep of the repo found none).
2. **Delisted/sold data (extra calls).** `GET /v2/search/car/recents` ("Past Inventory Search") "exclusively returns expired listings" from the past 90 days, with a `sold` filter for inferred sold cars. "All sold listings are expired listings, but not all expired listings are sold" ([Past Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/past-inventory-search)). It needs a location filter, returns up to 50 rows per call, and supports `price_change_range` and `dom_active_range` filters. Price: $0.0025 per call, described as "Access expired and sold dealer listings from the past 90 days" ([pricing](https://marketcheck.com/pricing)). Unverified: whether the Free plan (500 calls a month, `MONTHLY_CALL_BUDGET = 500` in `data_ingest.py:27`) may call it. The pricing page says Basic and Standard have "Access to every API Endpoint" and does not state it for Free.
3. **Per-VIN price history (1 call per VIN).** `GET /v2/history/car/{vin}` returns listing history "since 2015" with price, miles, seller, source, first/last seen, 50 records per page; $0.006 per call ([History by VIN](https://docs.marketcheck.com/docs/api/cars/vehicle-history/history-by-vin), [pricing](https://marketcheck.com/pricing)). Good for a small audit sample (for example 100 to 200 VINs), far too costly for 31k listings on a 500-call budget.
4. **Sold summaries (aggregate only).** `GET /v2/sold-vehicles/summary` gives monthly sold counts and `dom_active` stats by state/city/national since 2021. The docs say "Prices are advertised asking prices at the time of sale, not negotiated transaction prices" ([Sold Vehicles Summary](https://docs.marketcheck.com/docs/api/cars/market-insights/sold-vehicles-summary)). Useful as a market-speed baseline (typical days to sell per make/model/state), not as a per-car label.
5. **No transaction price anywhere.** Marketcheck's own "sold" data is inferred from listings disappearing, with the last asking price. See idea 6 and question 3 below.

So the plan is: use item 1 first (free), then item 2 in a small, budgeted pilot, and item 3 only for an audit sample.

## Ranked ideas

| Rank | Idea | What it fixes | Effort | Needs new data or calls? | Confidence |
|---|---|---|---|---|---|
| 1 | Store the Marketcheck fields we drop (`dom_active`, `dom_180`, `ref_price`, `price_change_percent`, `first_seen_at*`, `last_seen_at`) and flag "already cut" and "relisted" | Tells us which "deals" are just markdowns; gives a price-cut label for validation. Fixes that `days_listed` is lifetime `dom`, which may include earlier listings | Low (map 6 fields, add columns) | Fields: no extra calls. Real population rate unverified | High on value, medium on field coverage |
| 2 | Survival analysis of "listing disappeared" (Kaplan-Meier, then Cox/discrete-time) comparing flagged vs unflagged, with entry times for left truncation | The main label-free validation: do flagged cars leave faster, given age? | Medium | Uses fix (1) in the session (scrape logs). `recents` can fill gaps | Medium-high |
| 3 | Show days listed and "price already cut" next to the stars; do not put age into the price model | Keeps the model a fair-price estimate; stops stale-car discounts reading as bargains | Low | None beyond the in-progress fix (2) | High |
| 4 | Same-VIN price-cut check using the repeat rows we already have | Free first test of "dealers cut prices on aged stock". 4,620 VINs have more than one `listing_id` | Low (one SQL query plus a plot) | None | Medium (selection bias, see below) |
| 5 | Blinded expert spot-check of about 100 flags plus 100 controls | Detects hidden condition problems (cause b) that no field shows | Low-medium (human time) | None | High, if blinding is honoured |
| 6 | Pilot `recents` pull (about 40 to 60 calls) to get sold/expired labels and compare with our "disappeared" signal | Ground truth for "left the market", with the caveat that expired is not sold | Medium | Yes, about 0.0025 USD per call; plan access unverified | Medium |
| 7 | Free VIN-level condition signals: NHTSA recalls by make/model/year (not VIN), listing-text keywords, NMVTIS via a paid approved provider only if the audit shows a need | Cheap, partial check for cause (b) | Medium | NHTSA free; NMVTIS paid | Low-medium |
| 8 | Score redesign: "deal = under comps AND not stale AND not already cut", with a stale down-weight and a fresh-only top tier | Makes 5 stars mean "new and cheap" | Low-medium | Needs ideas 1 and 3 first | Medium |

## 1. Store the fields we already pay for

**What.** The mapping at `scraper/data_ingest.py:180-215` keeps `dom` and drops everything else about time and price history. Marketcheck documents these on the listing object: `dom_active` ("Days on market while active"), `dom_180`, `dos_active`, `ref_price`, `ref_price_dt`, `price_change_percent`, `first_seen_at`, `last_seen_at` ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). Add columns and keep the latest value plus the first value seen.

**Why it matters here.** `dom` is "Days on market (lifetime)". For a VIN that was delisted and relisted, lifetime `dom` and `dom_active` can differ, so our "days listed" may be wrong in either direction. `ref_price` and `price_change_percent` directly show whether a cheap-looking car was recently cut. That is the exact confounder in the finding.

**How to use.** Add two flags: `recently_cut` (price_change_percent < 0) and `relisted` (`dom` much larger than `dom_active`). Report flag rates by stars. If 5-star cars are mostly `recently_cut`, cause (a) is confirmed at zero cost.

**Checks I ran.** Our DB fields `accident_count` and `owner_count` are constants: 0 accident rows above zero and 0 rows with `owner_count` above 1, out of 31,087. They come from `extra.accident_count` / `extra.owner_count`, which the feed does not populate for us. So we have no history signal at all today; do not treat these columns as features.

**Risk.** Unverified that the real response includes these fields on our plan. First step is to log one raw page response from the next scheduled call (no extra call) and count populated fields.

## 2. Survival analysis for "listing disappeared"

**What.** Treat "listing stops appearing" as the event, time as days since first seen (or since `first_seen_at` from Marketcheck, which is better: it is when the listing was first seen, not when we first saw it). Cars still active are censored. Compare flagged (4+ stars) and unflagged with Kaplan-Meier curves and a Cox model on stars plus controls (price tier, body type, dealer type).

**Two traps, both present in our data.**
- *Right censoring.* Most cars are still active, so the plain average of days listed is biased. Kaplan-Meier is valid for right-censored times; scikit-survival says so directly ([scikit-survival intro](https://scikit-survival.readthedocs.io/en/stable/user_guide/00-introduction.html)). The lifelines docs define right-censoring as cases "where we do not observe the death event" and show `kmf.fit(T, event_observed=E)` ([lifelines intro](https://lifelines.readthedocs.io/en/latest/Survival%20analysis%20with%20lifelines.html)).
- *Late entry (left truncation).* We first see most listings when they are already weeks old, and a car that sold before our scrape reached it is never seen. lifelines calls this "left-truncation (or late entry)" and supports an `entry=` array so each car only joins the risk set when we start observing it ([lifelines intro](https://lifelines.readthedocs.io/en/latest/Survival%20analysis%20with%20lifelines.html)). Use `entry = age_when_first_seen`. Without it, old cars look like survivors.
- *Length bias.* Sampling "what is on the lot now" over-represents long-lived listings. With prevalent-cohort data the censoring is informative, and Kaplan-Meier is not the correct estimator for the underlying survival curve; Asgharian, M'Lan and Wolfson (JASA 97, 2002) give the unconditional estimator ([Asgharian and Wolfson 2005, abstract summary via search; JASA 2002 paper itself unverified](https://www.arxiv.org/pdf/math/0602239)). Practical rule for us: only compare flagged vs unflagged within the same entry-age band, and prefer hazard ratios conditional on entry (Cox with `entry_col`) over absolute median times.

**Our extra problem: partial coverage.** Only 16% of listings were seen on more than one day, and the scraper rotates zips and pages. A listing can drop out of our view because the page rotated away, not because it sold. The "listing disappeared" signal must therefore only count a disappearance when the same search params were re-run and the listing was absent (this is why the scrape log fix matters). Treat everything else as censored at the last scrape that covered it. Also note the scraper takes `start=0` (freshest) every run and rotates deeper offsets (`data_ingest.py:312-321`), so fresh listings are re-observed far more often than deep-page old ones: observation intensity depends on age. That is another reason to use only covered-and-absent events.

**Tools.** `lifelines.KaplanMeierFitter`, `CoxPHFitter` and `scikit-survival.CoxPHSurvivalAnalysis` (docs above). Neither is in `requirements.txt`; add one (lifelines is the simpler API). I did not open the lifelines `CoxPHFitter` page (the page I fetched does not cover `entry_col`), so check that argument in its API reference before use (unverified).

**Competing outcome.** "Disappeared" mixes sold, wholesaled and dealer-feed churn. `recents` has `sold` and `expired` filters ([Past Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/past-inventory-search)); idea 6 uses that to check how much of "disappeared" is "sold".

**Expected result and how to read it.** If flags work, flagged cars should have a higher exit hazard at the same age. If they instead sit longer, the flag is catching problem cars. Both are informative.

## 3. Show age and price cuts beside the stars; keep age out of the price model

**Why not put `days_listed` in the model.** It is an outcome of the price, not a cause: a car priced too high sits, then the dealer cuts. Feeding `dom` to a regressor trained on asking prices makes the model learn "old listing, lower price" and predict a lower fair price for old cars. The deal gap then shrinks for exactly the stale cars, which hides them rather than explaining them. The model would also learn dealer reduction habits. That is the same failure as the dealer warning in `model_improvement_research.md`.

**What the literature supports.** In housing, the closest well-studied analogue, list price, price changes and time on market are jointly determined by the seller: see Merlo and Ortalo-Magné, J. Urban Econ. 56(2), 2004, whose data record all listing-price changes and offers between listing and sale ([abstract and data description via IDEAS](https://ideas.repec.org/a/eee/juecon/v56y2004i2p192-216.html); full text at [Penn PIER copy](https://economics.sas.upenn.edu/sites/default/files/filevault/working-papers/04-020.pdf), not read in full), and Knight, Real Estate Economics 30(2), 2002, on causes and effects of listing price changes ([bibliographic record only, abstract not opened](https://econpapers.repec.org/RAS/pkn26.htm); unverified findings). I found no peer-reviewed paper on used-car dealer markdowns with time on market after a targeted search; the closest hits were industry blogs, which I do not cite as evidence. Treat the housing results as analogy, not proof for cars.

**How to apply.** Keep the fair-price model age-free (it answers "what is this car worth"). Show `days_listed`, `recently_cut`, and a one-line explanation such as "listed 117 days, price cut 6%" next to the stars. The user then sees a flag and its likely reason. This is in the session's fix (2); this idea only says what to show beside the number.

## 4. Same-VIN price-cut check from the rows we already have

**What.** `listing_id` is `"{vin}-{marketcheck id}"` (`data_ingest.py:88-94`), so one VIN can appear as several rows when Marketcheck assigns a new listing id. I queried the DB read-only. Of 24,490 distinct VINs in 31,087 rows, 4,620 VINs have more than one row. Taking consecutive rows per VIN in `first_seen` order gives 6,597 pairs; 6,127 are at the same dealer. Price fell in 4,527 pairs (69%), rose in 985, was equal in 1,085; mean change -2.4%.

**Reading it.** This is a free first signal that dealers cut prices on re-observed cars. Warning on bias: a new row may be created because the listing changed (a price change can trigger it), so 69% down likely overstates the cut rate for all cars. It is evidence of the mechanism, not a rate. It does not need new calls.

**Use.** For each pair, test whether the earlier row was already a flagged deal. If the flagged cars' later price drops are about the same as unflagged, flags are not special. If the later price is lower than the first for flagged cars, they get cheaper over time, which supports "stale = markdown". Use paired differences with a bootstrap CI. Keep the first row's score from the time of scoring; note the `predictions` table keeps only the latest score per listing, so recompute scores with the saved model or start storing score history.

## 5. Blinded expert spot-check with sample-size math

**Protocol.**
1. Sample 100 listings scored 4+ stars and 100 controls with similar price tier, body type and model year (matched), shuffled, with stars hidden.
2. One or two reviewers open the dealer page and photos and record: price looks fair / high / low; visible damage; mileage plausibility; trim or option mismatch; history report availability; "would I buy at this price" (yes/no).
3. Add a duplicate subset of 20 to measure reviewer agreement (Cohen's kappa). If kappa is low, labels are noise.
4. Compare "problem found" and "genuine bargain" rates between flagged and control.

**Sample-size math (textbook formulas; I did not open a primary stats source, so this is unverified as to citation).**
- Precision of a single rate: n = z²·p(1-p)/d². For p = 0.5 and d = 0.10 at 95%, n = 96. For d = 0.07, n = 196.
- Comparing two proportions (flagged vs control) at alpha 0.05, power 0.80: n per group ≈ 7.85·(p1q1 + p2q2)/(p1-p2)². Detecting 40% vs 20% "problem found" needs about 82 per group; 30% vs 20% needs about 290 per group.
- Zero events in n spot checks: the upper 95% bound on the rate is about 3/n ("rule of three"), so 0 problems in 100 gives under 3%. (Unverified citation.)
- So 100 + 100 detects a large difference only. Stratify by price tier (cheap cars are where the model errs most, per the earlier docs).

**Blinding is the whole point.** If the reviewer sees the stars, they will find the problems they expect.

## 6. Pilot: Marketcheck `recents` (expired/sold) as a label

**What.** Pull `recents` for the zips we already scrape, `last_seen_days` set to a recent window, `sold=true` in one run and `expired=true` in another. Match returned VINs to our listings.

**Budget math.** 50 rows per call maximum, so 50 calls is at most 2,500 rows; at $0.0025 per call this is cents if on a paid plan, but on the Free plan the limit is 500 calls a month shared with the live scraper, so 50 calls is 10% of the month. Plan access for `recents` on Free is unverified. Run it once, small, after confirming access from the plan page or one test call by the owner.

**What it answers.** Of our flagged listings that vanished, how many are `sold` (inferred) vs merely `expired`? That calibrates how much to trust "disappeared" as a sale signal. It also gives `dom_active` at exit for a time-to-sale outcome without waiting on our own scrape coverage.

**Limit.** "Sold" is inferred and carries the last asking price, not the transaction price ([Sold Vehicles Summary](https://docs.marketcheck.com/docs/api/cars/market-insights/sold-vehicles-summary)).

## 7. Condition and history signals without manual work

| Signal | Free? | Legal to use? | What it gives | Verdict |
|---|---|---|---|---|
| NHTSA recalls | Yes (I ran a keyless GET to `api.nhtsa.gov/recalls/recallsByVehicle?make=honda&model=civic&modelYear=2015` and got JSON with campaign numbers) | Public government data; NHTSA's use policy warns the API is "NOT meant to be used by any other applications to perform bulk VIN lookups" and rate-controls them ([NHTSA API policy page](https://api.nhtsa.gov/)) | Open recalls by make/model/year, not by VIN. Every car of that model gets the same flag, so it does not separate cars | Low value for deal detection. Skip |
| NHTSA vPIC VIN decode | Yes (the documented `DecodeVinValues` returned data for a sample VIN) | Public; rate controlled, no stated limit ([vPIC docs](https://vpic.nhtsa.dot.gov/api/)) | Build/spec data. Docs do not mention recall or title-brand data | Could fill trim gaps (259 of 31,087 rows have no trim). Not a condition signal |
| Marketcheck AutoRecalls | No: $0.07 per call, third-party endpoint, needs Basic or higher ([pricing](https://marketcheck.com/pricing), [AutoRecalls](https://docs.marketcheck.com/docs/api/cars/third-party/autorecalls)) | Via Marketcheck terms | Recall by VIN incl. open/closed | Too costly for volume |
| NMVTIS title brands | Not through an API. Federal statute limits access to states, law enforcement, prospective purchasers, and insurers; "junk" and "salvage" status are covered ([49 U.S.C. 30502](https://www.law.cornell.edu/uscode/text/49/30502)). The program site routes consumers to purchased reports and does not mention a free API ([NMVTIS site](https://vehiclehistory.bja.ojp.gov/)) | Not for bulk scraping or resale by us. Verify with counsel before any commercial use | Salvage/junk brand | Use only as a small paid audit (a few VINs through an approved provider), not as a pipeline feature. Provider list and prices unverified |
| Marketcheck `vindata` (AAMVA report) | No (per call) | Via Marketcheck terms | VIN report | Not priced here, unverified |
| Listing text keywords | We do not store descriptions. Not in our mapping | Terms of Marketcheck and each dealer site apply; check before storing | Words like "salvage", "rebuilt", "as-is", "needs", "mechanic special", "flood" | Cheap check if the feed has a description field. I did not find a description field in Marketcheck's documented listing fields in the material I read, so unverified |

**Takeaway.** There is no free, legal, VIN-level title-brand source we can call in bulk. The best cheap proxy for hidden problems is the market's own behaviour (price cuts, long age, relisting), which ideas 1 and 2 capture.

## 8. Better deal-score design

**Today.** Score = 50 + 40 · diff_pct / (segment_error_pct · 3), clamp 0..100, with diff_pct = (predicted - actual) / predicted ([`ml/pipeline.py:924-946`](ml/pipeline.py)). This measures the gap to a model, in units of typical model error.

**Changes, in order of value.**
1. **Gate the top tier on freshness and no recent cut.** Show 5 stars only if `dom_active` is below a threshold (pick it from the survival analysis, not by guess) and `recently_cut` is false; otherwise cap at 4 stars and label "older listing" or "price already cut". This does not change the model.
2. **Compare to same-model comps and show the comp set.** `model_improvement_research.md` covers LODO comps; here the point is to show "priced X below N similar cars" so users can judge. Needs a minimum N (for example 8) or no star.
3. **Down-weight stale listings by shrinking toward 50, not by editing the price.** For example score' = 50 + (score - 50) · w(age) with w from the validated relation between age and flag precision. Fit w on the spot-check and survival results, never by hand.
4. **Intervals.** Conformal or quantile intervals so a flag needs the price to fall below the interval. Already covered in `model_algorithms_research.md` rank 2; no new work here.

**Not recommended:** adding `days_listed` as a model feature (see idea 3).

## Validation plan: sequence for proving the deal flags work

Do these in order. Each step is cheap and each gates the next.

1. **Log one raw Marketcheck page (no extra call)** and count how often `dom_active`, `dom_180`, `ref_price`, `price_change_percent`, `first_seen_at` are populated. Decision: if over 80% populated, idea 1 is the backbone. If empty on the free plan, fall back to ideas 2 and 4.
2. **Same-VIN price-cut test (idea 4)** on existing rows. Output: do flagged cars get cut more than unflagged, with a bootstrap CI? One afternoon.
3. **Add the dropped fields and the scrape log** (the session's fix 1 plus idea 1). Wait 3 to 4 weeks. Keep every score by scoring date (new `score_history` table, or at least score at first sight) so we can evaluate the flag as it was shown.
4. **Survival analysis (idea 2)** once about 4 weeks of covered-and-absent data exist: Kaplan-Meier flagged vs unflagged within entry-age bands, then Cox with `entry`. Use only covered-and-absent exits; censor everything else at the last covering scrape. Pre-register the question: "is the hazard of exit higher for 4+ stars, at the same age and price tier?" A hazard ratio above 1 supports the flag; at or below 1 says flags mostly find stale or problem cars.
5. **Blinded spot-check (idea 5)** of 100 flags plus 100 matched controls, plus a 20-car duplicate for reviewer agreement. Run it in parallel with step 4. This catches problems that survival cannot (a car may sit because it is bad).
6. **`recents` pilot (idea 6)**, about 50 calls, only after step 1 shows our own fields are thin or step 4 is ambiguous. Check what share of our "disappeared" are `sold`.
7. **Per-VIN history audit** (`/v2/history/car/{vin}`, 100 VINs at 0.006 USD each) on a random sample of flagged cars to see the real price path. Compare with steps 2 and 4.
8. **Decide and ship.** Ship the freshness/price-cut gate (idea 8.1) if steps 2 to 5 agree that the older flagged cars are markdowns or problem cars. Re-run steps 4 and 5 each quarter. Treat any one-off test as weak: use the dealer-grouped splits already in `model_improvement_research.md` so one big dealer does not dominate the result.

**What would count as proof.** Flags are working if: flagged cars at the same age exit faster, flagged cars are rated "fair or good" by blind reviewers more often than controls, and flagged cars are not more often `recently_cut` after controlling for age. Flags are not working if flagged cars exit slower at the same age and reviewers find more problems in them.

## Considered and rejected

- **Add `days_listed` as a price-model feature.** It is an outcome of pricing, and it removes the deal signal for stale cars (idea 3). Use it as a display and a gate.
- **Treat mean days listed as time to sale.** Censored and length-biased; see idea 2.
- **Treat Marketcheck "sold" as transaction price.** It is the last asking price ([docs](https://docs.marketcheck.com/docs/api/cars/market-insights/sold-vehicles-summary)).
- **NHTSA recalls as a per-car signal.** The free API I tested is by make/model/year; it cannot separate two cars of the same model, and bulk VIN lookups are discouraged by NHTSA's policy.
- **Buy NMVTIS or AutoRecalls for every listing.** NMVTIS access is restricted by statute; AutoRecalls costs $0.07 per call, which breaks the budget.
- **Per-VIN `history` for all listings.** 31,087 calls at $0.006 each, and a 500-call plan.
- **Use the Marketcheck predicted price (`marketcheck_price`) as a second opinion.** The docs say 90%+ of predictions for cars under 10 years are within 10% ([docs](https://docs.marketcheck.com/docs/api/cars/market-insights/marketcheck-price)), which is not tighter than our segment errors, and it costs a call per VIN. Not worth the budget.
- **Learn the "right" star threshold from the flags themselves.** Circular without outside labels.

## Unverified

- Whether the Free plan can call `recents`, `history`, or `sold-vehicles/summary`. The pricing page lists per-call prices but does not say which plan includes which endpoint ([pricing](https://marketcheck.com/pricing)).
- Whether real active-search responses on our plan populate `dom_active`, `dom_180`, `ref_price`, `price_change_percent`. Docs list them; we keep no raw payloads.
- Whether `dom` can exceed `dom_active` for relisted VINs in practice. The docs define both ("lifetime" vs "while active") but I have no examples.
- Marketcheck's `price_change` / `price_change_percent` semantics beyond the one-line field descriptions (what the reference price is, how often it resets).
- Whether the active-search listing object includes a free-text description field. Not seen in the docs I read.
- Official NHTSA recalls API documentation. `nhtsa.gov/nhtsa-datasets-and-apis` returned HTTP 403. The by-make/model/year endpoint behaviour is from my own request, not from NHTSA docs.
- NMVTIS approved provider list and prices; legal analysis of commercial use (DPPA, provider terms). Not opened.
- Findings of Knight (2002) and the Merlo and Ortalo-Magné results on price changes and time on market. I confirmed bibliographic records only. The Penn PIER PDF link was not read in full.
- Asgharian, M'Lan and Wolfson (JASA 2002). Only a secondary arXiv/Annals follow-up summary was seen; the 2002 paper was not opened.
- The `lifelines` `CoxPHFitter` `entry_col` argument. The page I read does not cover it.
- Sample-size formulas and the rule of three are standard but I did not open a primary stats text for them.
- No peer-reviewed paper on used-car dealer markdown dynamics or list-to-transaction price gap was found in a targeted search. Related used-car papers I confirmed exist but did not read for this question: Genesove, JPE 101(4), 1993 ([record](https://ideas.repec.org/a/ucp/jpolec/v101y1993i4p644-65.html)); Lacetera, Pope and Sydnor, AER 102(5), 2012 ([NBER w17030](https://www.nber.org/papers/w17030)); Larsen, REStud 88(2), 2021, wholesale auction bargaining with failed negotiations of 12 to 23% of gains from trade ([NBER w20431](https://www.nber.org/papers/w20431)); Gavazza, Lizzeri and Roketskiy, AER 104(11), 2014 ([LSE record](https://eprints.lse.ac.uk/55720/)). These concern wholesale or aggregate markets, not retail asking-to-sale gaps, so they do not answer question 3 for retail dealers. Larsen's public NBER dataset of wholesale auction bargaining ([NBER data page](https://nber.org/research/data/dealer-dealer-used-car-bargaining-and-auction-data-larsen-2020)) is the closest free source on asking vs final price, but it is wholesale.
