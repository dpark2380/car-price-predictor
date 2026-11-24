# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Primary: the owner (Daniel Park), who uses the site himself, and recruiters or hiring engineers evaluating his work. A reviewer typically spends 2 to 5 minutes, is technical, and is checking whether the data and the modelling are real and understood. Owner's words (2026-11-23): the site is "purely for me and potential recruiters to see, not really for real users", and is not monetised.
- What that reader needs: real numbers with their source, the method and its limits stated plainly, and failure cases shown (unrated cars, thin data), not a sales pitch.
- Secondary: anyone who lands on the public site while shopping for a used car in the western US. The shopper-facing views (search, listings, listing page, Price check) stay usable and honest for them, but scale, acquisition and conversion are not goals.
- Not a dealer tool: no inventory management or dealer-facing screens.
- Accounts, saved searches and price alerts are not built and are not planned for this audience; design choices should not rule them out.

## Product Purpose

Car Intel pulls active used-car listings from MarketCheck daily, estimates what each car should list for with a trained price model, and grades every listing on how far its asking price sits from that estimate. It also gives an on-demand estimate and range for any make, model, year and mileage. Success: a reviewer can see in a few minutes what data the site holds, how an estimate and grade are produced, and how accurate they are, and can check any figure against its source; a "Great deal" is not just model noise.

## Positioning

- The grade is scaled to the model's own typical error for that price band and cohort size, so a "Great deal" needs a discount of at least 3x the typical error (about 2 sigma). The same 20% discount is a top grade on a $25k car but not on an $8k car; rare cars get a wider yardstick. (README "Deal scoring", `ml/pipeline.py` `_deal_score_from_prices`.)
- Evaluation is honest and published: VIN-grouped splits, a held-out test used once, bootstrap CIs, and earlier inflated figures explicitly retracted (README "Results", `outputs/holdout_metrics.json`).
- [ASSUMED] Contrast with commercial deal sites (CarGurus, KBB, iSeeCars): those are not named as competitors anywhere in the repo; the user must confirm whether this framing is intended.

## Operating Context

- Four views, each with its own URL: home (search, quick-filter chips, "Priced furthest below market", shop by body type, "How prices are graded"), listings (filters, sort field plus asc/desc, "Only cars with a photo"), a listing page (photo gallery, price grade, market value, facts, NHTSA spec sheet, similar cars, link to the dealer's site), and price check (estimate plus a range where about half of similar cars list).
- Planned, design under review and not built (2026-11-23): a "Market & model" area with a car view (one VIN's price path), a model view, a brand view and a "How the estimate works" model card. Mockup reviewed as a published Artifact before any build.
- Data refreshes once a day (launchd on a Mac mini at 10:00 local); the footer shows "Listings updated ...". About 29,500 active listing rows, about 23,100 distinct cars (as of 2026-11-23) around 15 rotating western-US zip codes; cars, pickups and SUVs.
- Hosting: React (Create React App) on Cloudflare Pages at cars.danielpark.fyi; Flask API through a Cloudflare Tunnel at cars-api.danielpark.fyi; SQLite on the Mac mini.
- Tested on desktop Chrome and a phone viewport (Pixel 7) with Playwright (`frontend/e2e/app.spec.js`), including no horizontal scroll on phone.
- Single owner-operator (Daniel Park); [ASSUMED] no support, sales or content team.

## Capabilities and Constraints

- Only listings priced $3,000 and up are scored and shown; the model trains on $3k-100k, 0-400k miles.
- Grades on the site (`frontend/src/utils/scoreColor.js`): Great deal (90-100), Good deal (65-89), Fair price (35-64), High price (15-34), Overpriced (0-14). Anything within about one typical error of the estimate reads as fair. The API still returns "N Stars" labels; the site uses the plain words.
- Terminology in use: "market value", "below market", "Price check", "Listings", "graded on price", "Similar <Make> <Model>s".
- Known limits that the UI must not overstate: the target is the dealer's asking price, not a sale price; the model sees no condition or options data; it is a western-US model; error is about 8% median overall and much wider under $10k; few comparables triggers "treat this as a rough guide".
- History on hand is short: listings were first collected on 2026-03-23, on 67 scrape days, with none between 2026-06-17 and 2026-08-27. A listing row holds its latest price only; a price change shows up as a new listing row for the same VIN (6,406 VINs have 2 or more distinct prices, 1,637 have 3 or more, 501 appear at 2 or more dealers) or as MarketCheck's previous price (`ref_price`, on about 11,000 active rows). Coverage grew a lot in October 2026, so month-to-month medians before then mostly reflect sample mix. Longer per-VIN history (back to 2024) exists only through MarketCheck's on-demand history call, about 30 spare calls a month.
- The price model is now a router: XGBoost for cars it prices under $10k, and the mean of XGBoost, CatBoost and LightGBM above that (`PriceRouted` in `ml/pipeline.py`). Cars with no same make/model/year at other dealers are "Not rated", as are cars with 1-2 such comparables whose score lands in the top or bottom tier.
- Data gaps: many listings have no photo (shown as a short "No photo available" band; home's top deals show only cars with a photo); spec sheets fill in over time from NHTSA (hp/torque only where a true value was found); listings whose dealer site is down are hidden.
- Free-tier budgets bound the product today: MarketCheck about 450 of 500 calls a month, Auto.dev 30 photo calls a night, NHTSA 300 spec calls a night. There is no declared hard $0 limit: the site runs on free tiers now, and paid options are proposed to the owner and adopted only after the owner reviews them.
- Security constraints: strict CSP in `frontend/public/_headers` (no inline scripts, fonts only from Google Fonts, images from any https host, API connect only to cars-api.danielpark.fyi). The API is read-only.
- Light and dark themes, following the system unless the user toggles; the choice persists.
- Undecided: whether to show a comparable-cars count or price-history/price-cut reasons next to grades (raised in `research/deal_detection_research.md`); whether accounts, alerts or saved searches get built (not now; possible later).

## Brand Commitments

- Name: "Car Intel" (page titles use "Car Intel"; docs also write "CarIntel"). [ASSUMED] "Car Intel" with a space is canonical.
- Voice, from shipped copy and commit history: plain, factual, hedged where the data is uncertain, no hype. Examples: "Grades compare each asking price with a market-value model trained on recent listings in the western US." "Model specs from NHTSA. Confirm details with the dealer." "We've seen very few of this car recently, so treat this as a rough guide." Commits favor plain wording ("Make the README read more plainly", "Show makes and models in their usual spelling").
- No logo or icon exists: `frontend/public/manifest.json` is still the Create React App sample ("React App") and the favicon/logo PNGs appear to be CRA defaults [ASSUMED].

## Evidence on Hand

- Model accuracy: `outputs/holdout_metrics.json` (9,605 unique cars, 2026-10-15; XGBoost median abs error 8.2%, 95% CI 7.6-8.7) and the README Results table. That audit predates the current blend and the larger training set (23,775 cars on 2026-11-23); newer figures exist only in the training log (blend test MAE $2,743 on 4,755 held-out cars) until `scripts/holdout_audit.py` is re-run.
- Run history: `outputs/run_history/` (scrape, training and validation logs since April 2026).
- Serving latency: README table from `scripts/latency_bench.py`.
- Research notes: `research/*.md` (deal detection validation, photos, specs, deployment, model research).
- Absent, must not be fabricated: user counts, traffic, testimonials, reviews, press, savings achieved by users, sale-price validation (grades are not calibrated against actual sale prices), partnerships with dealers or data providers beyond API usage.

## Product Principles

1. [ASSUMED] Say only what the data supports: a grade reflects the model's measured uncertainty, and caveats (asking price, western US, rough guide on rare cars) stay visible rather than buried.
2. [ASSUMED] Plain words first, method one step behind: listings say "Good deal" and "$4,000 below market"; the formula, inputs and error figures are one click away for the reader who wants to check them.
3. [ASSUMED] Every view is linkable: filters, sort and price checks live in the URL so a result can be shared.
4. [ASSUMED] One operator, owner-approved spend: features run unattended and fit today's free-tier budgets; anything paid is proposed and reviewed by the owner first.
5. [ASSUMED] Never imply an endorsement or transaction: Car Intel grades listings and sends people to the dealer's own site.

## Accessibility & Inclusion

- Evidence of an existing bar: keyboard-operable custom dropdowns (tested), labelled landmarks and headings, `aria-live` on results and estimates, screen-reader text for links that open new tabs, `prefers-reduced-motion` handling in `index.css`, light/dark themes, no horizontal scroll at phone width.
- [ASSUMED] Target WCAG 2.2 AA; no formal standard is named in the repo.
