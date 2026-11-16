# True hp, torque and curb weight: search, extract and store

Run date 2026-11-16. Scope: find a free or near-free way to get a stated (never estimated) horsepower, torque and curb weight (MSRP if it comes along) per car configuration, store it once, and show it on listing pages. Paid spec APIs are out (CarSpecsAPI, RevCarData, Auto.dev Growth, carapi.app). I do not repeat `car_specs_apis_research.md`, `weak_spots_research.md` or `free_fields_research.md`.

Source rule: every outside claim has a link. "Unverified" means I could not confirm it in a primary source or a real response. I made about 22 web fetches and one download of an EPA file; no signups, no spend.

## Answer first

1. **"Google searching and storing results" is not available as an API.** The Custom Search JSON API "is closed to new customers" and existing customers must move off by January 1, 2027 ([Google](https://developers.google.com/custom-search/v1/overview)). Scraping google.com/search is disallowed in robots.txt (`Disallow: /search`, [robots.txt](https://www.google.com/robots.txt)) and Google's terms prohibit automated access that violates machine-readable instructions ([Google terms](https://policies.google.com/terms)). Bing's Search API was retired on August 11, 2025 ([PPC Land](https://ppc.land/microsoft-ends-bing-search-apis-on-august-11-alternative-costs-40-483-more/), secondary source). The idea still works if "Google searching" means "a search engine finds the page and we keep the number plus source". The engine just has to be something else.
2. **The best free source I found is not a search at all: EPA's annual test car list.** Each model-year file has a `Rated Horsepower` column per test vehicle (make, model with drive, displacement, cylinders, transmission). I downloaded the 2025 file and checked it: 4,287 data rows, 1,078 distinct (make, model, displacement, hp, test weight) combinations, and zero with blank hp. GM is in it: 63 Chevrolet, 32 Cadillac and a GMC set including Sierra 2.7 = 310, 5.3 = 355, 6.2 = 420, Terrain 1.5 = 175. This is a government certification dataset (public data, no licence restriction found; the page does not state one, so unverified). It has no torque, and its weight is test weight, not curb weight.
3. **For torque and curb weight, the only exact route is a page that states the number for that trim.** The cheapest way to read such pages at scale is the Claude API with web search plus a verbatim-quote rule. About $10 per 1,000 searches plus tokens, so roughly $25 to $300 for the whole 4,473 set depending on model (see cost section).
4. **The big review sites are mostly closed to bots.** Edmunds returned 403 to my robots.txt fetch, Cars.com returned a Cloudflare block ("Sorry, you have been blocked"), MotorTrend and Car and Driver block AI crawlers by name (Anthropic's among them). KBB's robots.txt does not disallow `/specs` paths but blocks ClaudeBot and Claude-User by name. Detail in the sites section.

## Options table

Coverage of the GM gap is my estimate from checking the 2025 EPA file and the search results below, not measured on our listings (unverified). "Exactness" means the number is stated for that configuration by the source.

| # | Source | Fields | Exactness | Join key | Cost at our scale | Licence / ToS | Est. GM gap coverage |
|---|---|---|---|---|---|---|---|
| 1 | [EPA test car list](https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy) (xlsx 2017-2026, csv 2000-2016) | Rated hp, test weight (ETW), displacement, cylinders, drive, transmission, EPA test group | hp: certified rating per engine/drive. Weight: inertia class only, not curb weight | year + make + model-with-drive + displacement (+ transmission) | Free, 27 small files | Public government data; licence not stated on the page (unverified) | hp: high for 2015+ (my guess 80% or more of GM listings; needs a join test). Weight: none usable |
| 2 | Claude API + web search + verbatim quote check | hp, torque, curb weight, MSRP, whatever the page states | Exact only if the number is quoted from a page naming that trim/engine; otherwise store nothing | VIN-decoded year/make/model/trim/engine | $10/1k searches + tokens; about $25 to $300 for 4,473 configs | Citations must be shown to end users ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)); the page's own terms still apply | Unknown until tested; GM trims are on many third-party spec pages |
| 3 | Manufacturer consumer pages and media sites (GM media, chevrolet.com, gmc.com) | hp, torque, curb weight (media spec sheets) | Exact, source of record | model-year + trim + engine | Free | media.gm.com returned 403 to my fetch (unverified why); gmc.com robots.txt allows `/` ([robots.txt](https://www.gmc.com/robots.txt)); pages are JS-heavy (unverified) | Best on paper, hardest to automate |
| 4 | Wikidata | Power output (P2109) and mass (P2067) if present | Exact when present, sparse per model-year (unverified) | Wikidata item per model/generation, not per trim | Free | CC0 ([licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)) | Low; per-trim coverage unlikely. A SPARQL count was blocked by the tool sandbox, so not measured |
| 5 | Wikipedia infoboxes and tables | hp, torque, weight per generation or engine | Exact only when the cited row matches the trim | Article per generation | Free | CC BY-SA 4.0: credit, link, licence notice, flag changes, share-alike ([Copyrights](https://en.wikipedia.org/wiki/Wikipedia:Copyrights)) | Low to medium, generation-level only. Share-alike may reach our stored text |
| 6 | Brave Search API (as the search step) | URLs and snippets only | n/a | n/a | 1,000 free searches/month via $5 credit, then $5/1k; card required ([Brave](https://brave.com/search/api/)) | Storing results needs a custom plan, "contact sales" (same page) | n/a |
| 7 | Exa | URLs plus page contents | n/a | n/a | $10 free monthly credits ("up to 2,500 Lite searches"); $4/1k Lite, $1/1k pages of contents ([Exa](https://exa.ai/pricing)) | Storage terms not checked (unverified) | n/a |
| 8 | Tavily | URLs plus extracted content | n/a | n/a | 1,000 free credits/month, then $0.008/credit ([Tavily](https://tavily.com/pricing)) | Storage terms not checked (unverified) | n/a |
| 9 | SerpAPI | Google results as JSON | n/a | n/a | 250 free/month; $25 for 1,000 ([SerpApi](https://serpapi.com/pricing)) | Legal Shield not included on Free or Starter (same page); this is scraped Google, see item 1 | n/a |
| 10 | NHTSA NCAP test reports | Test weight in PDFs | Per tested vehicle only | Make/model/year | Free | NHTSA page returned 403 to my fetch; not checked further (unverified) | Low; only NCAP-tested cars |
| 11 | Edmunds, Cars.com, KBB, MotorTrend, Car and Driver | Full spec tables incl. torque and curb weight | Exact per trim | Trim pages | Free to read in a browser | Blocked or restricted for bots, see below | Would cover most, but not for us to scrape |

Not found or not checked: DuckDuckGo (no official search API that I found; unverified), Kagi (not checked), Canadian and EU type-approval data (not checked).

## EPA test car list, what I verified

- Page lists one file per model year: xlsx for 2017 to 2026, csv for 2000 to 2016, zip for 1984 to 1999 ([EPA page](https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy)). Example file: [2025 xlsx](https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx).
- Header columns include `Model Year`, `Represented Test Veh Make`, `Represented Test Veh Model`, `Test Veh Displacement (L)`, `Rated Horsepower`, `# of Cylinders and Rotors`, `Tested Transmission Type`, `Drive System Description`, `Equivalent Test Weight (lbs.)`. No torque column.
- Sample rows I read: GMC Sierra 4WD AT4X 6.2 L = 420 hp, 6,000 lb ETW; Ford Ranger 2WD 2.3 L = 300 hp, 4,500 lb; Ford Mustang Mach-E RWD Extended = 290 hp (EV displacement shows as 0.001).
- ETW values are round numbers (4,000, 4,500, 5,250, 6,500...). They are EPA inertia-class weights, not curb weights, so do not show them as curb weight. The "curb weight plus about 300 lb" rule of thumb is unverified.
- Limit: it lists emissions test vehicles per test group, not every trim. Rated hp is per engine, which is the level our hp question needs. Model strings carry drive and trim fragments ("SIERRA 4WD MUD TERRAIN TIRES"), so matching needs normalisation by year, make, model family, displacement, drive.
- Caveat on "exact": EPA states hp for the test vehicle's engine configuration. If the same engine has two rated outputs (for example a truck tune versus a car tune), match on model and drive too, and drop the row on ambiguity.

## Review and spec sites, plainly

- **Edmunds**: robots.txt and the terms page both returned HTTP 403 ("Access Denied") to my fetch. I could not read their terms. Treat as off limits.
- **Cars.com**: robots.txt fetch hit a Cloudflare block page. Off limits for automated access.
- **KBB**: `/chevrolet/silverado-1500/2025/specs` is not disallowed for `User-agent: *`, but the file names ClaudeBot, Claude-User, Claude-SearchBot, GPTBot and others with their own restrictions ([robots.txt](https://www.kbb.com/robots.txt)). The terms of use were not fetched (unverified). Do not build on it.
- **MotorTrend**: disallows `anthropic-ai` and several other AI crawlers from `/` and lists many paths for all agents ([robots.txt](https://www.motortrend.com/robots.txt)).
- **Car and Driver**: same pattern, `anthropic-ai` disallowed site-wide ([robots.txt](https://www.caranddriver.com/robots.txt)).
- Claude's web fetch tool refuses URLs blocked by robots.txt (`url_not_allowed`, "robots.txt" named in the docs, [web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)), so most of these would fail inside that pipeline anyway. Third-party spec aggregators like auto123 and JD Power showed up in a search for the 2025 Silverado (hp, torque and weights present). I did not check their robots.txt or terms, and I would not store their numbers without doing so.
- Per the owner's rule, a number found on one of these sites would still be a copy from a site whose terms we have not cleared. Prefer manufacturer and government sources.

## Claude API pipeline, what the docs say

- Web search: **$10 per 1,000 searches** plus standard token costs; failed searches are not billed; batch API prices web search the same as normal ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)).
- Web fetch: no extra charge, only tokens. Does not render JavaScript pages. Can read PDFs. Cannot fetch URLs that did not already appear in the conversation, so search must come first, or we supply the URL ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)).
- Citations on web search carry `url`, `title` and `cited_text` of up to 150 characters; `cited_text` does not count toward tokens ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)). That is our quote and source URL for free. Web fetch citations are optional and give `start_char_index`/`end_char_index` ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)).
- `allowed_domains` limits search to a list (bare domains, optional path), so we can pin it to manufacturer sites, epa.gov, and so on. `max_uses` caps searches per request.
- Batch API gives 50% off tokens ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)).
- Token prices per million (input / output): Haiku 5.5 $0.10 / $0.50 up to 100k-token prompts; Sonnet 5.5 $2 / $10; Opus 5.5 $4 / $20 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). All three are on the web search supported model list ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)).
- Display rule: citations "must be included" when showing outputs to end users; if we reprocess, the docs say to consult a legal team (same page). Store the URL and show a "Source" link next to each number.
- Terms for the Anthropic API itself and the sites' own content are separate. Spec numbers are facts, but sites may still restrict automated copying; I did not run a legal check.

## Verification rule (fits "true value or none")

Accept a value only if all of these hold, else store nothing and retry later or give up:

1. **Quote is verbatim.** The number and unit appear inside `cited_text` (or the fetched text) character for character. We check this in code, not in the model's answer. Reject any value not found in the quote.
2. **Source tier A (one source enough):** a manufacturer domain (e.g. gm.com, chevrolet.com, gmc.com, cadillac.com, fordmedia.com), epa.gov or nhtsa.gov, where the page names the same model year and trim or engine.
3. **Source tier B (two sources needed):** any other page, and two independent domains must quote the same number for the same year, model, engine and drivetrain. Aggregators that copy each other do not count as independent; require different registrable domains and no shared "powered by" text (judgement call, unverified how often this fails).
4. **Configuration match is checked in code:** the quote or page title must contain the model year and either the engine displacement or the trim string we searched for. Weight must also match drivetrain (2WD vs 4WD) and body or cab.
5. **Sanity bounds, not estimates:** hp 40 to 1,500, torque 40 to 1,500, curb 1,000 to 12,000 lb; reject outside. A bound only rejects; it never fills a value.
6. **Disagreement rule:** if two accepted sources disagree, store nothing and flag for review.
7. **Per field, not per car:** hp may be accepted while weight is not.

EPA hp rows (option 1) are tier A on their own once the join is unambiguous, and need no model call.

## Recommended pipeline

1. **EPA join first (free, deterministic).** Download the year files once into a scratch area, normalise, and write rated hp to the new table for every (year, make, model family, displacement, drive) that matches uniquely. Estimate: this alone may close most of the GM hp gap (unverified; run the join and count).
2. **Claude search for what is still empty,** per configuration, one request each, tools: web search with `allowed_domains` set to manufacturer sites first, then an open second pass only if the first returns nothing. Ask for JSON: per field `value`, `unit`, `source_url`, `quote`, or null.
3. **Code verifies** with the rules above, then writes rows. A failed field is written as a "checked, nothing found" row with `checked_at` so we do not retry nightly.
4. **Show on the listing page** only fields that have a row; always show the source link (and the "per EPA" note for hp from EPA).
5. **Trickle:** the nightly job finds configurations seen in new listings that have no row, and runs steps 1 to 3 for them.

Configuration key: `(year, make, model, trim_or_version, engine_desc, drivetrain, body_cab)`. For hp the key can drop trim; for weight it cannot. Store hp and weight rows at different key depths and look up the deepest match.

### Store schema sketch

One table, one row per (config key, field):

```
spec_facts(
  id            INTEGER PRIMARY KEY,
  year          INTEGER, make TEXT, model TEXT,
  trim          TEXT NULL,      -- NULL means "any trim with this engine"
  engine        TEXT NULL,      -- normalised e.g. "5.3L V8"
  drivetrain    TEXT NULL,      -- 2WD / 4WD / AWD / FWD / RWD
  body          TEXT NULL,      -- cab/bed or body style, when weight depends on it
  field         TEXT,           -- hp | torque_lbft | curb_weight_lb | msrp_usd
  value         REAL NULL,      -- NULL = checked, nothing verifiable found
  unit          TEXT,           -- hp | lb-ft | lb | usd
  source_url    TEXT NULL,
  source_tier   TEXT NULL,      -- A_official | A_epa | B_two_sources
  quote         TEXT NULL,      -- verbatim text containing the number
  second_url    TEXT NULL,      -- tier B only
  second_quote  TEXT NULL,
  method        TEXT,           -- epa_join | claude_search
  fetched_at    TEXT,           -- ISO date
  UNIQUE(year, make, model, trim, engine, drivetrain, body, field)
)
```

A listing looks up its facts by VIN-decoded keys. This sits beside `vin_specs` and `model_specs` (existing tables, not changed here).

## Cost estimate

Assumptions (mine, unverified): 2.5 searches per configuration on average, 15,000 input tokens and 1,000 output tokens per configuration (search results are loaded into context per the docs), no batch discount unless stated. EPA step first, which removes some hp-only lookups; I do not subtract that here.

| Run | Searches | Search cost | Haiku 5.5 tokens | Sonnet 5.5 tokens | Total Haiku | Total Sonnet |
|---|---|---|---|---|---|---|
| Top 1,000 configs | 2,500 | $25 | about $2 | about $40 | about $27 | about $65 |
| All 4,473 configs | 11,180 | $112 | about $9 | about $180 | about $121 | about $292 |
| All 6,836 (with trim) | 17,090 | $171 | about $14 | about $275 | about $185 | about $446 |

Token math: Haiku 15k x $0.10/M + 1k x $0.50/M = about $0.002 per config; Sonnet 15k x $2/M + 1k x $10/M = $0.04 per config. The Batch API halves token cost (not search cost, which is the same per the docs). The search fee dominates on Haiku. If the first search with a manufacturer-only `allowed_domains` finds nothing more often than I assumed, the count goes up. Ongoing trickle: new configurations are a small share of the 4,473 set per week (unmeasured), so dollars per month should be single digits (unverified).

Brave's free 1,000 searches a month would not cover the one-off run and forbids storing results without a custom plan, so it does not replace the Claude search fee. Exa's $10 free monthly credit is about 2,500 Lite searches but only returns pages for us to parse ourselves, which brings back the extraction problem.

## Cheapest next experiment

1. **EPA join (about 1 hour, free).** Download the year files 2015 to 2026 into the scratchpad, normalise model names, join to the GM listings missing hp (Chevrolet 2,444, GMC 1,080, Cadillac 258 from the facts you gave), and count the share matched uniquely. Hand-check 20 matches against a manufacturer page.
2. **Claude search on 20 GM configs (under $2 on Haiku, about $5 on Sonnet).** Pick 20 configurations from the top GM engine/trim list that EPA cannot resolve (weight and torque especially), run the pipeline with the verification rules, and hand-check every returned number and quote. Record: share accepted, share wrong, share "nothing". Compare Haiku and Sonnet on the same 20.
3. Decision rule: if hand-check shows any accepted-but-wrong value, tighten rules before scaling. A tier B pass rate under about 50% on torque and weight is a sign that the owner will have to accept blank weights for many cars.

## Open questions

- Does Anthropic's web search return manufacturer pages for specific trims, given JS-rendered consumer pages? Not tested; no API key used here.
- Do the manufacturer sites' terms allow storing their spec numbers? Numbers are facts, but I did not read chevrolet.com, gmc.com or gm.com terms. Needs a read before the one-off run.
- GM media site gave 403 to my fetcher; is there a public spec-sheet PDF per model year? Unverified.
- Weight: EPA gives only test weight. For true curb weight on GM we depend on manufacturer spec pages (or the vPIC weight, which we already have for 70%). Is "none" acceptable for the remainder?
- Torque has no free structured source found. Is torque required, or optional "if stated"?
- Wikidata and Wikipedia coverage per trim not measured; CC BY-SA share-alike on stored text needs an owner decision if used.
- Search-API storage terms for Exa and Tavily not checked. Claude web search results are returned to us with a no-storage-restriction statement not found either way (unverified); we would store only our extracted number, URL and a short quote.
- MSRP: no source tested here beyond what the pages happen to state.
