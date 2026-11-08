# Car specs APIs for listing detail pages

Run date 2026-11-08. Scope: CarSpecsAPI, CarVector and RevCarData, checked against their own docs, pricing, terms and coverage pages, plus the free NHTSA vPIC and NHTSA Safety Ratings APIs as a baseline. The goal is a carsales.com.au-style spec sheet (Safety & Security, Engine, Transmission & Drivetrain, Fuel, Steering, Wheels & Tyres, Dimensions & Weights, Other) for our US used-car listings. Each claim links to its source. "Not stated" means the site does not say it; "could not fetch" means the page did not load. Live requests were read-only GETs to free endpoints; no commercial API was called with a key, since all of them need one.

## Summary

- **CarSpecsAPI covers almost the whole spec sheet, but specs are not on its free plan.**
  - The trim spec object has 76 fields, including length, width, height, wheelbase, curb weight, towing, hp, kW, torque, 0–100 km/h, top speed, fuel tank, steering type and turning circle ([docs](https://carspecsapi.com/docs), [openapi.json](https://carspecsapi.com/openapi.json)).
  - The free plan only includes "makes, models and generations". Trims and specs need Starter: $19.99/mo or $199/yr ([vehicle-data-api](https://carspecsapi.com/vehicle-data-api), [pricing](https://carspecsapi.com/pricing)).
- **CarSpecsAPI's catalogue looks European, not US.**
  - All units are metric, and acceleration is 0–100 km/h only.
  - The docs examples are European trims ("320d MT", "M340i Steptronic xDrive", "EURO VI") ([docs](https://carspecsapi.com/docs)), and the free sample is BMW 7 Series diesels ([car-database-download](https://carspecsapi.com/car-database-download)).
  - US coverage is not stated. "European catalogue" is my inference from these examples.
- **RevCarData has the widest field list and a one-time CSV option, but US coverage is unproven and the site shows caution signs.**
  - Its 53 fields include tyre sizes and fuel tank ([revcardata.com](https://revcardata.com/)).
  - The free API tier is 100 requests a month, for non-commercial use.
  - The US CSV costs €289 one-time.
  - Its free sample is all European makes.
- **CarVector is not a spec-sheet source.**
  - It has no dimensions, weights, torque, acceleration, tyres, steering or fuel tank ([docs/api](https://carvector.io/docs/api)).
  - Storing results needs the $249/mo Business plan ([pricing](https://carvector.io/pricing)).
- **NHTSA vPIC is free and already covers a good share.** VIN decode gives hp, kW, curb weight (lb), wheelbase, track, wheel size, top speed, ABS, ESC, airbags and ADAS. Fill rates are not stated ([vPIC API](https://vpic.nhtsa.dot.gov/api/), [variables](https://vpic.nhtsa.dot.gov/api/vehicles/GetVehicleVariableList?format=json)).
- **vPIC `GetCanadianVehicleSpecifications` adds dimensions for free.** It returns length, width, height, wheelbase, track and curb weight by year/make/model, in US units with `Units=US` ([vPIC API](https://vpic.nhtsa.dot.gov/api/)).
- **NHTSA Safety Ratings gives crash-test stars for free**, by year/make/model.
- **Recommendation:**
  - Build from the free NHTSA sources first.
  - Probe CarSpecsAPI and RevCarData US coverage on their free tiers before any spend.
  - Skip CarVector.

## Spot checks (2026-11-08, by hand)

- **CarSpecsAPI pricing page text:** Free "100 requests/day · Basic endpoints (makes, models, generations)". Starter "1,500 requests/day · All endpoints including trim specs + VIN decoder" ([pricing](https://carspecsapi.com/pricing)).
- **CarVector [docs/api](https://carvector.io/docs/api):** the field names found are `horsepower` and `displacement_l`. None of `wheelbase`, `curb_weight`, `length_mm` or `torque` appear.
- **vPIC Canadian specs, [2019 Toyota Camry](https://vpic.nhtsa.dot.gov/api/vehicles/GetCanadianVehicleSpecifications/?year=2019&make=toyota&model=camry&units=US&format=json) with `units=US`:**
  - 5 trim groups.
  - First group "CAMRY 4DR SEDAN LE": OL 192.5 in, OW 72.0 in, OH 58.3 in, WB 111.4 in, CW 3,296 lb, weight distribution 60/40.
- **vPIC `DecodeVinValues`, 2019 Camry VIN pattern:**
  - Filled: Trim "L/LE/SE/XLE", EngineHP 203, CurbWeightLB 3,572, WheelBaseShort 111.2, ABS and ESC "Standard", front airbags "1st Row (Driver and Passenger)".
  - Empty: WheelSizeFront and TopSpeedMPH.

## CarSpecsAPI (carspecsapi.com)

### Lookup methods
- **Access:** base URL `https://carspecsapi.com/api`, with an `X-API-Key` header. Server-side only, no CORS ([docs](https://carspecsapi.com/docs)).
- **Hierarchy:**
  - `GET /v2/cars/makes`
  - `/makes/{makeId}/models`
  - `/models/{modelId}/generations` (`yearFrom`, `yearTo`)
  - `/generations/{generationId}/trims`
  - `/trims/{trimId}` (spec sheet)
  - There is no year/make/model/trim query. The site's answer is "Walk the hierarchy" ([vehicle-data-api](https://carspecsapi.com/vehicle-data-api)). Year is matched through a generation's year range ([openapi.json](https://carspecsapi.com/openapi.json)).
- **Trim names** are engine and gearbox variants ("320d MT", "330i Steptronic xDrive"), not US equipment grades like "SE" or "XLE AWD" ([docs](https://carspecsapi.com/docs)).
  - Matching would need our stored engine size, cylinders, drivetrain, transmission and fuel type rather than the trim string (my suggestion; the docs give no guidance).
- **VIN decode:** `POST /v2/vin-decoder/decode` returns up to 143 attributes, with a `trim` string but no `trimId` linking to the specs database ([vin-decoder-api](https://carspecsapi.com/vin-decoder-api)).
  - Its field names match the NHTSA vPIC variables almost one for one ([vPIC variables](https://vpic.nhtsa.dot.gov/api/vehicles/GetVehicleVariableList?format=json)). The source is not named.
- **Response format:** `{ success, data, meta }`. Values are strings with comma decimals (`"4,4"`) and `|` ranges, and missing fields are omitted. The M340i example returned 47 of 76 fields ([docs](https://carspecsapi.com/docs)).

### Fields by carsales group
From the `TrimSpecs` schema ([openapi.json](https://carspecsapi.com/openapi.json)). "VIN:" means the field comes only from the VIN decoder.

| carsales group | CarSpecsAPI fields |
|---|---|
| Safety & Security | `ratingName`, `safetyAssessment` (contents not stated). VIN: ABS, ESC, traction control, airbag locations, ADAS, backup camera, TPMS |
| Engine | `engineType`, `capacityCm3`, `engineHp`, `engineHpRpm`, `maxPowerKw`, `maximumTorqueNM`, `turnoverOfMaximumTorqueRpm`, `numberOfCylinders`, `cylinderLayout`, `valvesPerCylinder`, `boostType`, `injectionType`, `compressionRatio` |
| Transmission & Drivetrain | `transmission`, `numberOfGears`, `driveWheels` |
| Fuel | city/highway/mixed L/100 km, `fuelTankCapacityL`, `fuelGrade`, `rangeKm`, `co2EmissionsGPerKm`, `emissionStandards`, EV battery/range/charging |
| Steering | `steeringType`, `turningCircleM` |
| Wheels & Tyres | `wheelSizeR14` only. **No tyre size** |
| Dimensions & Weights | `lengthMm`, `widthMm`, `heightMm`, `wheelbaseMm`, front/rear track, `groundClearanceMm`, `curbWeightKg`, `fullWeightKg`, `payloadKg`, `trailerLoadWithBreaksKg` (towing), trunk capacity |
| Other | `acceleration0To100KmPerHS`, `maxSpeedKmPerH`, suspension, brakes, `carClass`, `countryOfOrigin` |

All values are metric ([vehicle-data-api](https://carspecsapi.com/vehicle-data-api)). There is no 0–60 mph field.

### Coverage
- "70,000+ trims from 1945 to present", updated weekly ([home](https://carspecsapi.com/)).
- Markets: not stated. The FAQ only says the separate VIN decoder "works best for vehicles sold in the US" ([vehicle-data-api](https://carspecsapi.com/vehicle-data-api)).

### Pricing ([pricing](https://carspecsapi.com/pricing))
| Plan | Price | Limit | Endpoints |
|---|---|---|---|
| Free | $0 | 100/day | makes, models, generations only |
| Starter | $19.99/mo or $199/yr | 1,500/day | all, incl. trim specs + VIN decoder |
| Pro | $39.99/mo or $399/yr | 6,000/day | all |
| Database | $799/yr | 6,000/day + CSV downloads | all |

Limits reset at midnight UTC. Going over returns a 429, with no overage charges ([terms §5](https://carspecsapi.com/terms)).

### Terms ([terms](https://carspecsapi.com/terms), updated Oct 16, 2026)
- **Licence, §7:** "limited, non-exclusive, non-transferable license to use the Data for your own applications and projects". No resale, no redistribution, and no "competing car specifications database or API" (§3).
- **Showing data publicly:** not stated in the terms. The database page lists "spec sheets and comparison tables" as uses ([car-database-download](https://carspecsapi.com/car-database-download)).
- **Caching, keeping data after cancelling, attribution:** not stated.
- **Governing law:** North Macedonia. 99.9% uptime is an aim, not a guarantee.

### Reliability signals
- No about, status or changelog page. No legal entity is named.
- Contact: support@carspecsapi.com. Terms effective March 21, 2026. Payments go through Polar.
- Publishes an OpenAPI spec and a Postman collection.

## RevCarData (revcardata.com)

Checked first-hand on 2026-11-08: the [home and pricing page](https://revcardata.com/), the [data licence](https://revcardata.com/data-license/), and the [free sample CSV](https://revcardata.com/wp-content/uploads/2026/05/Free_sample_2026.csv). API docs are at https://api.revcardata.com/docs; I didn't read the endpoint details.

- **Fields:** "53 specification fields". The sample's columns:
  - Identity: Region, Make, Model, Year, generation, trimLevel, baseMSRP_USD and _EUR, bodyType, doors, seats
  - Engine: engineType, engineDisplacement_CC, fuelType, horsepower_HP, torque_NM
  - Drivetrain: transmissionType, numberOfForwardGears, driveWheelConfiguration
  - Dimensions & Weights: length_MM, width_MM, height_MM, wheelbase_MM, groundClearance_MM, curbWeight_KG, cargoVolume_LTR, standardTowingCapacity_KG
  - Performance and fuel: accelerationTime_0_100, fuelConsumption_L_100KM, emissionsCO2_G_KM, fuelCapacity_LTR
  - EV: batteryCapacity_KWH, evRange_KM
  - Wheels & Tyres: frontTireSize, rearTireSize
  - Safety: numberOfAirbags
  - Other: infotainmentScreenSize_IN, isDiscontinued
- **Units:** metric. Acceleration is 0–100 km/h.
- **Coverage claims:** "454,434 vehicle records", "295 makes, 8,934 models", "EU, US, and Asian markets", 1900–2026. The North America claims include "exact towing capacities (kg) and curb weights" and "EPA mileage ratings" ([home](https://revcardata.com/)).
- **Free sample:**
  - 524 rows, all Region "Global".
  - Makes: Skoda 353, Vauxhall 117, Smart 54. No US makes, so it can't confirm US coverage.
  - Most columns are filled on 524/524 rows, including acceleration, tyre sizes and airbag count. Towing is 446/524.
- **API pricing ([home](https://revcardata.com/)):**

| Plan | Price | Requests | Notes |
|---|---|---|---|
| Developer | €0 | 100/month | "Basic endpoints", "Non-commercial use" |
| Pro | €29/mo or €279/yr | 10,000/month | 53 data points, VIN decoding |
| Business | €89/mo or €859/yr | 50,000/month | "Commercial Use License" listed here only |
| Enterprise | €199/mo | 500,000/month | |

- **CSV pricing (one-time):**
  - EV & hybrid: €149
  - Single region, US, EU or Asia: €289, with 6 months of updates
  - Global: €499, with 1 year of updates
- **Licence ([data-license](https://revcardata.com/data-license/)):**
  - "The license ends when your subscription ends; you must stop using the data and delete cached copies." Whether a one-time CSV purchase is perpetual is not stated.
  - Public-facing uses "should credit 'Vehicle data by RevCarData'" with a link.
  - Bans include publishing "the full dataset, or a substantial extract, as a download or public API", and building a competing database.
  - The FAQ says a purchase gives "full rights to use the data within your commercial applications". That conflicts with the pricing table listing the commercial licence on Business only.
- **Caution signs:**
  - "Tested by 286K+ developers" and star ratings, with no source.
  - Lorem-ipsum placeholder text in the site footer.
  - A sample filled near 100%, including acceleration for every trim, which suggests some values may be estimated. Its data-quality method was not checked.

## CarVector (carvector.io)

- **Lookup:** `GET /v1/vehicles?year=&make=&model=`. There is no `trim` or `vin` parameter, and VIN decoding is on the [roadmap](https://carvector.io/roadmap) ([docs/api](https://carvector.io/docs/api)).
- **Fields:**
  - Spec fields: `horsepower`, `cylinders`, `displacement_l`, `transmission`, `drive_type`, `fuel_type`, `body_class`, `doors`, `image_url` (an illustration).
  - Data on top: recalls on every plan, complaints from Pro, TSBs and investigations from Business.
  - Missing: dimensions, weights, torque, acceleration, tyres, steering and fuel tank.
- **Coverage:** about 12,340 year/make/model entries across 41 makes ([vehicles](https://carvector.io/vehicles)). Trim-level coverage is not offered.
- **Pricing ([pricing](https://carvector.io/pricing)):**
  - Free: 500/month
  - Developer: $39/mo, 10K
  - Pro: $79/mo, 100K
  - Business: $249/mo, 1M
  - "Caching / storage rights" only from Business up.
- **Terms ([terms](https://carvector.io/legal/terms)):**
  - Geneva Lakes Media LLC, under Wisconsin law.
  - No data-licence clause.
  - §7.3 bans "automated systems (bots, scrapers)" without permission.

## Government sources (free)

**NHTSA vPIC** ([vpic.nhtsa.dot.gov/api](https://vpic.nhtsa.dot.gov/api/))
- **Decode endpoints:** `DecodeVinValues` (partial VINs with `*`) and `DecodeVINValuesBatch` (up to 50 VINs per call).
- **Rate limits:** there is an "automated traffic rate control mechanism", with no numbers given.
- **Relevant variables** ([list](https://vpic.nhtsa.dot.gov/api/vehicles/GetVehicleVariableList?format=json)):
  - Engine: hp from/to, kW, displacement, cylinders, configuration, turbo
  - Other: top speed (mph)
  - Dimensions & Weights: curb weight (lb), wheelbase, track width, GVWR
  - Wheels: wheel size front/rear (in)
  - Steering: steering location
  - Brakes: brake system
  - Safety: ABS, ESC, traction control, TPMS, airbag locations, seat belts, ADAS
- **Gaps:** torque, acceleration, fuel tank, tyre size, turning circle, towing, and length/width/height.

**vPIC `GetCanadianVehicleSpecifications`**
- **Inputs:** year (1971 or later), make, optional model, and `Units=US`.
- **Outputs:**
  - OL, OW, OH (overall length, width, height)
  - WB (wheelbase)
  - TWF, TWR (front and rear track)
  - CW (curb weight)
  - WD (weight distribution)
- **Market:** Canadian, grouped by trim (e.g. "CAMRY 4DR SEDAN LE"). US equivalence is not stated.

**NHTSA Safety Ratings** (api.nhtsa.gov)
- `/SafetyRatings/modelyear/{y}/make/{m}/model/{model}` returns variants, e.g. "2019 Toyota Camry 4 DR FWD", VehicleId 13200.
- `/SafetyRatings/VehicleId/{id}` returns:
  - overall, front, side, side-pole and rollover ratings
  - ESC, forward-collision and lane-departure equipment
  - complaint, recall and investigation counts
- Two calls per year/make/model.
- The [datasets page](https://www.nhtsa.gov/nhtsa-datasets-and-apis) returned 403, so terms and limits are unchecked.

## Coverage table

F = full, P = partial, N = none. "Have" = already free from Marketcheck.

| carsales group | Have | vPIC decode | vPIC Canadian | NHTSA ratings | CarSpecsAPI (Starter+) | RevCarData | CarVector |
|---|---|---|---|---|---|---|---|
| Safety & Security | N | P (ABS, ESC, airbags, ADAS) | N | P (stars) | P (contents unknown) | P (airbag count) | P (recalls) |
| Engine | P (L, cyl) | P (hp, kW, turbo) | N | N | F (incl. torque) | F (hp, torque) | P (hp) |
| Transmission & Drivetrain | F | P (+ speeds) | N | N | F | F | P |
| Fuel | P (type, mpg) | P | N | N | F (+ tank) | F (+ tank) | N |
| Steering | N | P (location) | N | N | F (type, turning circle) | N | N |
| Wheels & Tyres | N | P (wheel size) | N | N | P (wheel size) | F (tyre sizes) | N |
| Dimensions & Weights | N | P (WB, track, curb, GVWR) | F except towing | N | F (+ towing) | F (+ towing, clearance) | N |
| Other / performance | P (doors, seats, body) | P (top speed) | N | N | F (0–100, top speed) | P (0–100) | P |

## Cost scenarios

Our volumes: 7,433 active trims, 2,739 trims among 4–5 star deals, 3,920 active year/make/model, 17,879 active VINs, 55 makes and 801 make/model pairs (all rows).

- **NHTSA: $0.**
  - About 358 batch decode calls.
  - Up to 3,920 Canadian-spec calls.
  - Up to 7,840 ratings calls.
  - Throttle, since limits are unpublished.
- **CarSpecsAPI:**
  - The free plan can't return specs.
  - One Starter month ($19.99) covers a backfill: about 860 hierarchy calls plus up to 7,433 spec calls, at 1,500 a day, so 6–8 days.
  - Keeping it running costs $199/yr.
- **RevCarData:**
  - The free API covers 100 calls a month, enough to probe coverage only.
  - The one-time US CSV (€289) means local lookups with no call limits, if the licence allows keeping it.
  - Pro (€29/mo) covers the API backfill, but the commercial licence is on Business (€89/mo).
- **CarVector:** storing results needs $249/mo, and it adds only `horsepower`, which vPIC already has.

## Recommendation

1. **Build the free baseline now, cached per VIN pattern and per year/make/model:**
   - vPIC decode
   - vPIC Canadian specs (`Units=US`)
   - NHTSA Safety Ratings

   This fills Safety (partly), Dimensions & Weights (except towing), and most of Engine.
2. **Probe US coverage for free** before any spend:
   - CarSpecsAPI: walk the makes, models and generations hierarchy on its free plan.
   - RevCarData: search our top make/model/years on its free API.
3. **If one passes, buy the cheapest way to fill the gaps:**
   - CarSpecsAPI: one Starter month.
   - RevCarData: the one-time US CSV, after confirming whether it's perpetual.
   - Either way: torque, 0–100 km/h, fuel tank and towing; RevCarData adds tyre sizes.
   - Show acceleration as "0–100 km/h", not 0–60 mph.
   - Match trims on engine, drivetrain and transmission, not the trim string.
4. **Skip CarVector.**

## Open questions

- Coverage: do CarSpecsAPI and RevCarData cover US-market models from 2015 to 2026? The free-tier probes answer this.
- RevCarData licence:
  - Is a one-time CSV licence perpetual?
  - Does a no-revenue public site count as "non-commercial"?
  - Is a per-listing specs endpoint an allowed use?
- CarSpecsAPI licence: may data cached during a paid month be kept after cancelling? Ask support@carspecsapi.com.
- vPIC fill rates on our VINs: to be measured with one batch of 50.
- NHTSA API terms and limits: the overview page returned 403.
- 0–60 mph: none of the sources checked provide it.
