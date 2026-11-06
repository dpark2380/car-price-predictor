# Free fields to improve price prediction and deal detection

Run date 2026-11-01. Scope: only data that costs nothing and needs no extra Marketcheck calls. I read `deal_detection_research.md`, `model_research.md`, `model_improvement_research.md` and `model_algorithms_research.md` and do not repeat them (the dropped time/price fields `dom_active`, `dom_180`, `ref_price`, `price_change_percent`, `first_seen_at*` are covered there; I only add the leakage rule for them).

Source rule: every outside claim has a link. "Unverified" means I could not confirm it in a primary source or in a real response. I could not see a real Marketcheck response (`logs/marketcheck_sample.json` does not exist yet), so every Marketcheck field below is "documented", not "confirmed populated".

## Answer first

1. **Two columns we think we have are dead, and the docs explain why.** The active-search listing object has no `extra` object and no `dealer.rating` ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). `extra` (options, features, seller comments) lives only on the per-listing endpoint `GET /v2/listing/car/{listing_id}`, one call per listing ([Car Listing Details](https://docs.marketcheck.com/docs/api/cars/vehicle-listing/car-listing)). Our `map_listing` reads `extra.accident_count`, `extra.owner_count` and `dealer.rating` (`scraper/data_ingest.py`, `map_listing`). That is why `accident_count` is always 0, `owner_count` always 1, and `dealer_rating` is NULL in 31,574 of 31,574 rows (I checked the DB read-only). No history field was ever mapped.
2. **The real free condition proxies are on the listing object and we drop them:** `is_certified`, `carfax_1_owner`, `carfax_clean_title`, `dealer.dealer_type`, `seller_type`, `msrp`. They are weak and sparse (the first two Carfax flags are only set "if the dealer mentions it"), but they cost nothing.
3. **Our model ignores most of the VIN-decoded spec the response already carries.** `build` documents `drivetrain`, `engine_size`, `cylinders`, `transmission`, `fuel_type`, `doors`, `version`, `powertrain_type`, `std_seating`, `city_mpg`, `highway_mpg`. Our features use none of them (only `trim`, `body_type`, make/model/year/state/zip3/color). AWD vs FWD, a turbo 4 vs a V6, hybrid vs gas are all hidden inside `trim` today.
4. **No field-level plan restriction is documented.** The pricing page lists Free limits as 500 calls/month, 5 calls/second, a 100-mile radius and 500-row pagination, and does not say which endpoints Free includes ([pricing](https://marketcheck.com/pricing)). The search docs say only that the pagination limit and the maximum radius depend on the package ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). So whether a field is empty on Free is untested.
5. **FRED is a bad fit; BLS direct is fine.** FRED's API terms forbid storing/caching content and forbid using the API to train machine-learning systems ([FRED legal](https://fred.stlouisfed.org/legal/)). BLS says its material is public domain and asks for citation ([BLS copyright](https://www.bls.gov/opub/copyright-information.htm)).

## Ranked table

Leakage risk = chance the feature lowers MAE by explaining away real deals (see "Dealer warning" in `model_improvement_research.md`) or encodes an outcome of pricing. Effort: S = hours, M = a day or two.

| Rank | Field or source | Helps | Effort | Leakage risk | Confidence it helps | Needs sample check |
|---|---|---|---|---|---|---|
| 1 | `build.drivetrain`, `engine_size`, `cylinders`, `transmission`, `fuel_type`, `powertrain_type`, `doors`, `version` | Price and deals | S-M (add columns, map, add to features) | Low | High (documented, large spec effect) | Fill rate per field |
| 2 | `is_certified` | Both | S | Low-medium (franchise proxy) | High for price, medium for deals | Value type (0/1/null) |
| 3 | `carfax_1_owner`, `carfax_clean_title` (tri-state: true / missing) | Both | S | Low | Medium (sparse, missing is not random) | Fill rate, any `false` |
| 4 | `msrp` (as a level, not as price/msrp) | Price | S | Medium (see section) | Medium | Fill rate on used cars |
| 5 | Rental/fleet seller flag from `dealer.name` (Hertz 3,155 rows, Enterprise 444) | Both | S | Medium (dealer proxy) | Medium | None (name only) |
| 6 | `price_includes_fees`, `fees` (price comparability) | Deals | S | Low | Medium | Fill rate |
| 7 | `vehicle_status`, `in_transit`, `availability_status`, `alternate_vin` (filters, not features) | Deals | S | None | Medium | Value sets |
| 8 | `dealer.dealer_type`, `seller_type`, `dealership_group_name` | Deals (segment calibration), price with caution | S | High as a feature | Medium | Values |
| 9 | `dealer.latitude/longitude`, `msa_code` | Price | S-M | Medium (identifies dealers at fine splits) | Low-medium | Populated |
| 10 | NHTSA vPIC decode (only to fill gaps and add `EngineHP`) | Price | M | Low | Low-medium | n/a |
| 11 | EPA vehicles.csv (EV/hybrid class, fuel cost, VClass) | Price | M | Low | Low (we already get MPG) | n/a |
| 12 | BLS used-car CPI as a time deflator | Price | S-M | Low | Low (short window) | n/a |
| 13 | Media photo count | Neither much | S | Medium (dealer effort) | Low | `media.photo_links` length |
| 14 | NHTSA recalls/complaints by make/model/year | Display only | M | Low | Very low for price | n/a |
| 15 | Same-VIN history, dealer markup, regional supply, seasonality, `price_change_percent`, `dom*`, `ref_*` | Do not use as price features | n/a | High | n/a | see sections |

## 1. `build` spec fields (rank 1)

**What.** `build` lists: year, make, model, trim, version, body_type, vehicle_type, transmission, drivetrain, fuel_type, engine, engine_size, engine_block, doors, cylinders, made_in, overall height/length/width, std_seating, highway_mpg, city_mpg, powertrain_type ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). The `/listing` endpoint documents a shorter set (no `engine`, `engine_size`, `engine_block`, `cylinders`) ([Car Listing Details](https://docs.marketcheck.com/docs/api/cars/vehicle-listing/car-listing)), so I trust the search page for search.
**We store:** year, make, model, trim, body_type only. `db/models.py` has no drivetrain, engine, transmission, fuel, doors columns.
**Free-plan restriction:** none documented.
**Price value.** Large and direct. A 2018 Accord 4-cyl vs V6, a RAV4 FWD vs AWD, a Silverado 2WD vs 4WD, diesel, hybrid, EV: these are real price steps. `trim` (99% populated here: 31,314 of 31,574) only partly encodes them. `trim_rank` in the pipeline is a ranking of trim names, not specs. Expected effect: the largest of any candidate here; I would guess a few percent of MAE, but I measured nothing (unverified). Test with the dealer-grouped split.
**Deal value.** Positive. Fewer false deals from AWD/V6 cars compared against FWD/4-cyl comps. Low dealer-warning risk, because these are car attributes, not seller attributes.
**Leakage.** None. Caveat: `version` is free text and `trim` and `version` may overlap, so pick one after the sample.
**How.** Add columns, map them, add categoricals `drivetrain`, `transmission`, `fuel_type`, `powertrain_type` and numerics `engine_size`, `cylinders`, `doors`. Keep `highway_mpg`/`city_mpg` numerics too (they are documented here, so EPA is mostly redundant, rank 11). Rows scraped before the change have NULL: keep CatBoost/LightGBM native missing handling, or backfill (rank 10).

## 2. `is_certified` (rank 2)

**What.** "Set to 1 only when the car is certified pre-owned" ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). The definitions page does not define it ([data definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)); the meaning comes from the API reference only.
**We store:** no. **Plan restriction:** none documented.
**Price.** CPO cars carry a documented-by-the-field, observable premium and an inspection. Without this flag the model sees them as overpriced and shrinks everything. I did not find a primary source for the size of the CPO premium (unverified), so measure it on our data.
**Deals.** Helps: a CPO car looks "overpriced" against non-CPO comps today. It is also the nearest free condition proxy (a manufacturer inspection happened).
**Leakage.** Low-medium. CPO exists only at franchise dealers, so it partly proxies `dealer_type`. It is a property of the car, not a pricing decision, so keep it. Check the dealer-grouped gate.
**Missing semantics.** "Set to 1 only" suggests 0/absent are the same. Treat as binary.

## 3. `carfax_1_owner`, `carfax_clean_title` (rank 3)

**What.** Single-owner flag and clean-title flag, "if the dealer mentions it" ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). Not defined on the data-definitions page ([data definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)). These are scraped dealer claims about a Carfax report, not a report pull.
**We store:** no (our `owner_count` is not this field).
**Value.** This is the only free history-flavoured signal. The catch: absence means "dealer did not say", not "bad". Encode as three states: true, false, missing. A model can learn "true" = small premium and "missing" = neutral. Do not treat missing as a defect.
**Deals.** If `carfax_clean_title` is explicitly false on a cheap car, that is a strong "do not flag as a deal" gate. If the field only ever holds true or null, it only helps price slightly. The sample check decides this.
**Leakage.** Low. Dealers who bother to say it may price higher, so a mild dealer-style proxy; again, dealer-grouped gate.
**Effort.** Small. Expected size: small, because of sparsity (unverified; fill rate unknown).

## 4. `msrp` (rank 4)

**What.** "The manufacturer's base retail price, excluding dealer options, taxes, fees, and discounts", scraped from the source site; filters `msrp` and `msrp_range` exist ([data definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)). It is "as shown on the dealer site" ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)).
**Reality check.** Used-car dealer pages rarely show an MSRP. I expect it to be mostly empty on used listings. This is an expectation, not a documented fact (unverified).
**Price.** If populated even 20-30% of the time, MSRP is a strong trim/option-level proxy: it separates a loaded trim from a base trim of the same model. Use as a numeric (NaN when missing) and as `log_msrp`.
**Leakage.** Medium, in one way. Do NOT use `price / msrp` as a feature (it is built from the asking price, so the model would learn its own target). `msrp` alone is safe. Also, "base retail price" means it excludes options, so it will not capture option packages.
**Deals.** Shows depreciation vs new; a good display ("listed 38% under original MSRP"), not a score input.

## 5. Rental and fleet seller flag from the dealer name (rank 5)

**What.** `dealer_name` is stored. Hertz Car Sales San Diego alone is 2,961 rows; `%hertz%` matches 3,155 of 31,574 rows (10%), `%enterprise%` 444, `%carvana%` 121, `%carmax%` 28 (my read-only query). Ex-rental cars have different wear, usage and typical pricing. A keyword flag (`is_rental_fleet`) is the nearest free "usage history" proxy we have.
**Price.** Probably real but mostly absorbed by mileage; Hertz stock tends to be a few recent model years (unverified).
**Deals.** Useful as a caution: ex-rental at a "deal" price may just be fair for that history. This is a car attribute (prior use), which is a legitimate feature.
**Leakage / dealer warning.** Medium. For one big lot it equals a dealer identity (2,961 rows from one dealer). Accept only if the dealer-grouped holdout does not get worse and big-dealer flag rates look normal. A safer use: show a label "ex-rental seller" in the UI and leave it out of the model.
**Do not use** `dealer_name` one-hot, dealer count or dealer median price (already rejected in `model_improvement_research.md`).

## 6. Price comparability: `price_includes_fees`, `fees` (rank 6)

**What.** `fees` is "total of fees identified on the listing page, when available"; `price_includes_fees` says whether the advertised price includes them ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)).
**Use.** If the price excludes fees and `fees` is present, adjusted price = price + fees for scoring. If it already includes fees, leave it. This is a deal-detection fix (dealer doc fees can run into the hundreds of dollars, but I have no primary source for a size, so do not assume one). Start by storing both and measuring how many rows have a non-null `fees`.
**Leakage.** None, it is a measurement correction. Do not feed `fees` into the price model; correct the price instead and train on the corrected value only after reviewing a sample.

## 7. Filters: `vehicle_status`, `in_transit`, `availability_status`, `alternate_vin`

**What.** `vehicle_status` ("Available", "Coming Soon" and similar), `in_transit`, `availability_status`, `alternate_vin` (non-standard VIN shown when the VIN fails validation) ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)).
**Use.** Keep non-available and in-transit cars out of the deal list and out of training (prices may be placeholders), and drop rows with `alternate_vin` set (VIN-keyed logic breaks on them). Cheap, no model change. The values seen in a real response are unknown until the sample exists.

## 8. Dealer attributes: `dealer_type`, `seller_type`, `dealership_group_name`, `mc_dealership.*` (rank 8)

**What.** `dealer_type` is "franchise or independent", derived from brand associations, not scraped ([data definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)). `seller_type` is dealer, private or auction (same page). `dealership_group_name` and `mc_dealership_group_name` give the group ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). The `dealer` object in the docs has no rating field; `dealer_rating` will stay empty (confirmed NULL in all rows).
**Price.** Franchise vs independent is a real price level shift (CPO, reconditioning, overhead). Two levels only, so it cannot memorize a dealer. It will lower MAE a little.
**Deals.** Mixed. As a feature it explains away "franchise is pricier" markups, which is the dealer warning in a mild form. Better use: keep it out of the price model, and use it to compare a car with same-type comps in the UI, or to calibrate the score per dealer type.
**Group name** is a dealer proxy with many levels: do not use it as a feature.
**Rule.** Add only if the dealer-grouped holdout MAE improves and the flag rate for franchise vs independent stays close.

## 9. Dealer location: `latitude`, `longitude`, `msa_code` (rank 9)

**What.** In the `dealer` object ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). We store city, state, zip only.
**Value.** Numeric lat/lon lets trees learn smooth regional price gradients and replaces the zip3 one-hot, which has a lot of levels. But fine splits on lat/lon recover individual dealers (one dealer = one coordinate). Round to about 0.5 degrees or use `msa_code` as a coarse region to limit that. Expected MAE gain small; gate with the dealer-grouped split.

## 10. NHTSA vPIC VIN decode (rank 10)

**Official facts.** vPIC is free and keyless. Endpoints include `DecodeVinValues` (flat) and `DecodeVINValuesBatch` (max 50 VINs per batch), and partial VINs are supported ([vPIC API](https://vpic.nhtsa.dot.gov/api/)). The page publishes no numeric rate limit; traffic is "controlled by an automated traffic rate control mechanism" ([vPIC API](https://vpic.nhtsa.dot.gov/api/)). The NHTSA API policy page says the API "is NOT meant to be used by any other applications to perform bulk VIN lookups" ([NHTSA API policy](https://api.nhtsa.gov/)). That statement is on the NHTSA API page, which does not name vPIC specifically, so how it applies to vPIC is unverified.
**What I saw.** One keyless call (`DecodeVinValues`, a 2003 Honda Accord VIN, `modelyear` set) returned 154 keys, 45 non-empty, including `EngineHP` (240), `DisplacementL`, `EngineCylinders`, `TransmissionStyle`, `TransmissionSpeeds`, `BodyClass`, `Doors`, `FuelTypePrimary`, `Trim` ("EX-V6"), `GVWR`, `PlantCountry`, `ValveTrainDesign`, `ErrorText` (clean decode). One VIN is not a coverage study: I do not know how often `Trim` is blank on modern VINs (unverified).
**Does it beat Marketcheck `build`?** For the fields Marketcheck documents (drivetrain, engine size, cylinders, transmission, fuel, doors), probably not, since Marketcheck already decodes them. What vPIC adds: `EngineHP` (not in Marketcheck's `build` list), `TransmissionSpeeds`, `GVWR`, plant. Horsepower could matter for sporty and luxury trims. Everything else is redundant.
**Plan if wanted.** Backfill only: decode each distinct VIN descriptor once (the response shows `VehicleDescriptor` "1HGCM826*3A": the 8 VIN characters before the check digit plus year/plant characters), cache forever, and trickle new ones. This is my inference, not a vPIC-documented practice; check it on a few VINs before relying on it. With 24,830 distinct VINs, descriptor caching should cut calls a lot, but I did not count distinct descriptors. Do it slowly given the policy wording above.
**Verdict.** Do after rank 1. Only worth it if the sample shows `build` is often blank, or if HP is wanted.

## 11. EPA FuelEconomy.gov (rank 11)

**Official facts.** Free JSON/XML web services; vehicle record fields include `comb08` (combined MPG), `fuelCost08` ("based on 15,000 miles, 55% city driving, and the price of fuel used by the vehicle"), `co2`, `VClass`, `phevBlended`, `charge120/240`, `rangeA`; bulk files `vehicles.csv.zip` and `emissions.csv.zip` ([FuelEconomy.gov web services](https://www.fueleconomy.gov/feg/ws/index.shtml)). The page states no terms of use, rate limits, license or attribution rule, so those are unverified; it says the site is run by Oak Ridge National Laboratory for the U.S. Department of Energy.
**What I saw.** `GET /ws/rest/vehicle/26425` (2010 Prius) returned `atvType` "Hybrid", `comb08` 50, `fuelCost08` 1300, `VClass` "Midsize Cars", `drive`, `displ`, `cylinders`, `trany`, `phevBlended`, EV fields. `menu/options?year=2015&make=Honda&model=Civic` lists vehicle IDs by transmission/engine.
**Use.** Join is by year/make/model plus engine/drive text, not by VIN, so it is a fuzzy join. Marketcheck `build` already has city and highway MPG, so EPA adds little for MPG. It adds: EV/PHEV/hybrid class (`atvType`), EV range, fuel cost, and EPA size class (`VClass`). Fuel cost uses the fixed 15,000-mile assumption, so it adds a year-level fuel-price shift only, not live gas prices.
**Value.** Low for price; slightly useful for EV/hybrid segment features. Use the bulk CSV once, not the API, to avoid load. Leakage: none.

## 12. BLS used-car CPI as a time adjustment (rank 12)

**Series.** CPI-U Used Cars and Trucks, US city average, seasonally adjusted, monthly, index 1982-84=100, source BLS; the FRED page showed 182.176 for Sep 2026, next release 2026-11-10 ([FRED CUSR0000SETA02](https://fred.stlouisfed.org/series/CUSR0000SETA02)). The same series is published by BLS itself.
**Why not FRED API.** The API requires an account key ([FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html)); its terms bar caching/storing and bar use "in connection with" developing or training machine-learning systems, and require a notice ([FRED legal](https://fred.stlouisfed.org/legal/)). Training a price model is exactly that. Rejected.
**BLS Public Data API.** v1 needs no key: 25 queries/day, 10 years per query, 25 series per query; v2 needs free registration: 500/day, 20 years, 50 series ([BLS API FAQ](https://www.bls.gov/developers/api_faqs.htm)). BLS material is public domain; cite BLS ([BLS copyright](https://www.bls.gov/opub/copyright-information.htm)). The BLS terms-of-service page itself was not opened (unverified). The series ID is the same one shown on FRED.
**Value.** We train on asking prices scraped March to October 2026, with 16,310 of 31,574 rows first seen in October. A national monthly index moves by small amounts month to month, and it is published about two weeks after month end, so the current month is always missing. At best it deflates old rows to today's level. Expected MAE gain: small. Not worth building before ranks 1-5. Leakage: low (market-level, not car-level).

## 13. Photo count (rank 13)

**What.** `media.photo_links` is an array of dealer photo URLs ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)); we keep only the first. Count is `len(photo_links)`.
**Value.** A dealer-effort proxy, weak for price. For deals, a listing with 0-1 photos may be a fresh intake not yet detailed. It is also a dealer-style proxy (big groups upload many photos), so it can mimic dealer identity. Expected gain small. Store it as a column because it costs one `len()`, and decide after the data exists. Do not put it in the price model without the dealer-grouped gate.

## 14. NHTSA recalls and complaints by make/model/year (rank 14)

**Official facts.** The NHTSA API policy page does not mention recalls or complaints endpoints and says nothing numeric about rate limits ([NHTSA API policy](https://api.nhtsa.gov/)). `nhtsa.gov/nhtsa-datasets-and-apis` returned HTTP 403 for me, so the official dataset page was not read (unverified).
**What I saw.** Keyless calls worked: `complaints/complaintsByVehicle?make=honda&model=civic&modelYear=2015` returned `count` 381 with per-complaint records (components, crash/fire flags, injuries, summary text). `products/vehicle/models?modelYear=2015&make=honda&issueType=r` returned a model list for recalls. `SafetyRatings/modelyear/2015/make/Honda/model/Civic` returned two vehicle IDs (the ratings need a second call per ID).
**Value.** Complaint counts rise with fleet size and age, so they mostly re-encode `model` and `year`, which the model already has as categoricals. Per model-year recall counts say nothing about a given car's open recalls. Expected price MAE gain: close to zero. I would show a "N NHTSA complaints for this model year" link in the UI, not feed the model. Leakage: low, but adds noise.

## 15. Derived features from data we already have

| Idea | Verdict | Why (with the evidence) |
|---|---|---|
| Listing-text keywords | Not possible for free | We store no text. `seller_comments`, `options`, `features` exist only in the per-listing `extra` object ([Car Listing Details](https://docs.marketcheck.com/docs/api/cars/vehicle-listing/car-listing), [data definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)), 1 call per listing. `heading` (title) is on the search listing ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)) and is free: try keywords there ("salvage", "rebuilt", "certified", "as-is"), but titles rarely carry that. Confirm in sample. |
| Same-VIN price history as a feature | Do not use as a price feature | A prior price is an earlier outcome of the same dealer's pricing. A VIN seen twice also appears on both sides of a random split. Use it only for validation, as in `deal_detection_research.md` idea 4. Number of `listing_id`s per VIN (a "relist count") is an outcome of the car not selling; display only. |
| Dealer markup tendency | Do not use as a price feature | This is the dealer warning verbatim: it makes overpriced lots look fair. Use only in leave-one-dealer-out scoring. |
| Dealer inventory size (`dealer_n`) | Do not use | Already flagged in `model_improvement_research.md`. In our data a few dealers dominate (Hertz San Diego 2,961; Titus-Will Toyota 797); 206 of 780 dealers have 30+ rows. |
| Franchise vs independent from the name | Use the documented `dealer_type` instead | Name matching is brittle; the field is derived by Marketcheck ([data definitions](https://docs.marketcheck.com/docs/guides/data/cars/inventory/data-definitions)). Keep the name flag only for rental/fleet (rank 5). |
| Regional supply (comparable listings near the same zip) | Reject | Our scraper samples about 5 calls a day and rotates zips and pages (`deal_detection_research.md`), so the count of comps near a zip reflects our scrape coverage, not real supply. 83 zips have 20+ active rows out of 146. It would learn the scraper. |
| Seasonality (month of year) | Reject for now | Rows first seen span 2026-03 to 2026-10, with 16,310 in October and only 575 in August. Less than one full year, and month is confounded with scrape coverage. Revisit after 12 months. |
| `price_change_percent`, `ref_price`, `ref_miles`, `dom`, `dom_active`, `dom_180`, `dos_active`, `first_seen_at*` | NOT price-model features | These are outcomes of pricing: a car that does not sell gets cut and ages. Feeding them makes the model predict lower prices for old or cut listings and hides stale-car markdowns, the same mechanism `deal_detection_research.md` idea 3 describes. Display and gate only. |
| `financing_options`, `leasing_options` | Skip | Dealer promos, not car attributes. |
| `model_code` | Maybe, as a trim tie-breaker | A manufacturer model code can separate sub-variants; population unknown. Only after the sample. |

## Rejected (paid or not useful)

- Rejected: paid. Listing `extra` (options, features, seller comments) via `GET /v2/listing/car/{id}`: one call per listing out of 500 a month.
- Rejected: paid. Marketcheck history, `recents`, AutoRecalls, NeoVIN decoded options, `marketcheck_price`, Carfax or NMVTIS reports (prices and limits in `deal_detection_research.md`).
- Rejected: paid. Any higher Marketcheck plan (the user said no).
- Rejected: not useful. FRED API (terms bar caching and ML training use, [FRED legal](https://fred.stlouisfed.org/legal/)); use BLS if the index is wanted.
- Rejected: not useful. `dealer.rating` (no such field in the documented dealer object; NULL in every row).
- Rejected: not useful. `accident_count`, `owner_count` as written (no such search field).
- Rejected: not useful. Complaint/recall counts as price features; regional supply; seasonality; dealer markup; dealer size; `price_change_percent` and DOM fields as price features.

## Confirm in `logs/marketcheck_sample.json`

Read the first 50 listings, not one. For each field: how many are non-null, and what values appear.

- [ ] `build.drivetrain`, `engine_size`, `cylinders`, `transmission`, `fuel_type`, `powertrain_type`, `doors`, `version`, `engine`: fill rate and value sets (rank 1).
- [ ] `build.trim` vs `build.version`: do they overlap or conflict?
- [ ] `is_certified`: values (1 / 0 / null)?
- [ ] `carfax_1_owner`, `carfax_clean_title`: fill rate; do any `false` values exist, or only `true`/null?
- [ ] `msrp`: fill rate on used cars; is it plausible vs year/model?
- [ ] `dealer.dealer_type`, `seller_type`, `dealer.dealership_group_name`, `mc_dealership` present?
- [ ] `dealer.rating`: expected absent. Any rating-like key anywhere?
- [ ] `extra` object: expected absent from search (confirm no `extra`, `seller_comments`, `options`).
- [ ] `heading`: does it carry trim/keywords? Any "certified"/"salvage" words?
- [ ] `price_includes_fees`, `fees`: fill rate, and is `price_includes_fees` true or false most often?
- [ ] `vehicle_status`, `in_transit`, `availability_status`, `alternate_vin`: value sets; how many are not "Available"?
- [ ] `dealer.latitude/longitude`, `msa_code`: populated?
- [ ] `media.photo_links`: array length distribution; any cached links with an api key (our code already filters these).
- [ ] `dom`, `dom_active`, `dom_180`, `dos_active`, `ref_price`, `ref_price_dt`, `price_change_percent`, `ref_miles`, `first_seen_at*`: fill rate (for display and validation only).
- [ ] `model_code`, `stock_no`: populated?
- [ ] Are any fields present in the sample that the docs do not list? (Our `map_listing` also reads `car_type` and `dp_price`, which the docs I read do not list; `inventory_type` is the documented name.)
- [ ] Is `miles` or `price` ever a string or zero?

## Unverified

- Whether any listed field is empty on the Free plan. The docs I read give no per-field restriction; the pricing page does not say which endpoints Free includes ([pricing](https://marketcheck.com/pricing)).
- Fill rates for every Marketcheck field above (no raw response yet).
- Size of the effect of each candidate on MAE and on flag rates. All "expected value" statements are reasoned guesses; none was tested.
- Size of the CPO premium and ex-rental discount (no primary source found).
- The exact definitions of `carfax_1_owner`, `carfax_clean_title`, `is_certified`, `dom_180`, `ref_price`, `price_change_percent`, `version`, `powertrain_type`: absent from the data-definitions page I read; I rely on the one-line API reference text.
- Whether the NHTSA "no bulk VIN lookups" policy applies to vPIC, and its real throttle. vPIC's own page publishes no number.
- vPIC `Trim` coverage on modern VINs and whether descriptor caching works as I described (one VIN tested).
- FuelEconomy.gov terms, rate limits, license: not stated on the page I read.
- BLS Terms of Service page: not opened.
- NHTSA datasets page (HTTP 403), including any official recalls/complaints API documentation and rate limits.
- FRED `CUSR0000SETA02` copyright notes: the page shows both "copyrighted" and "Public Domain: Citation Requested" wording; another reason to use BLS directly.
- The count of distinct vPIC descriptors in our DB (not computed).
- The `version`/`engine` fields on the `/listing` endpoint differ from the search page; I assumed the search page is right for the search response.

## Confirmed fill rates (one live response, 2026-11-01, 50 listings, "cars" target)

One extra active-search call, same search as the daily scrape. Small sample, one region, so treat the rates as rough.

| Field | Filled | Notes |
|---|---|---|
| `build.transmission`, `drivetrain`, `fuel_type`, `doors`, `version`, `std_seating`, `city_mpg`, `highway_mpg`, `made_in` | 50/50 | Spec features are available on the free plan. |
| `build.powertrain_type` | 49/50 | |
| `build.engine`, `engine_size`, `engine_block`, `cylinders` | 43-44/50 | Missing on some (likely EVs). |
| `dealer.dealer_type` | 50/50 | 36 franchise, 14 independent. |
| `dealer.phone`, street, lat/lon | 50/50 | A fallback when a dealer's website blocks visitors. |
| `dom_active`, `dom_180`, `first_seen_at` | 50/50 | Deal display only, never price features. |
| `ref_price`, `price_change_percent` | 40/50, 38/50 | Mostly small cuts (-1% to -2%). Deal display only. |
| `price_includes_fees`, `fees` | 36/50 | |
| `carfax_1_owner` | 50/50 | True only at franchise dealers (20/36); every independent listing is False, so False means "not reported", not "multiple owners". |
| `is_certified` | 2/50 | Too sparse to matter. |
| `carfax_clean_title` | 0/50 true | Always False: useless. |
| `msrp` | 50/50 | **Equals `price` in 50/50**: a copy of the asking price, not the factory MSRP. Must never be a feature (it leaks the target). |

The `extra` and `dealer.rating` objects are absent, as the docs say.
