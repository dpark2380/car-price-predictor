# Listing photos: closing the gap without fighting Cloudflare

Run date 2026-11-08. Scope: why many listings show no photo, whether the Cloudflare block on DealerCenter-hosted dealer sites is the cause, and which legitimate routes would close the gap. Repo facts cite `file:line` or the SQL I ran against `car_intel.db` (read-only). External claims link to their primary source. "Unverified" means I could not confirm it from a primary source or without a login or paid signup. Network activity was limited to DNS lookups, two single `robots.txt` requests and one image `HEAD` request, all with an honest User-Agent (details below). No code was changed. Evading bot protection is out of scope and not covered.

## Summary

- **The block is not what is causing the gap.**
  - The pipeline never requests a dealer web page. It calls MarketCheck (`scraper/data_ingest.py:365`), NHTSA (`scraper/vehicle_specs.py:54`) and, once a day, opens a bare TCP connection to each dealer host (`scraper/dealer_sites.py:28-35`). `audit.md` says the same: "There is no HTML scraping."
  - Photo URLs come from MarketCheck's `media.photo_links` (`scraper/data_ingest.py:241-247`). No dealer page is needed to get them.
- **The headline gap is mostly a data-age artifact, not missing photos.**
  - 15,809 of 22,074 active listings (71.6%) have no photo.
  - But 14,949 of those 15,809 were last seen before 2026-10-30, the day photo capture was added. They have never been re-fetched since.
  - Among active listings seen since 2026-10-31, 264 of 5,911 (4.5%) have no photo. For listings first seen since then, it is 125 of 3,610 (3.5%).
- **DealerCenter is the largest single photo source, not the biggest hole.**
  - 1,436 of the 5,911 recently seen active listings (24%) use photos on `imagescf.dealercenter.net`, a CDN separate from the dealer sites.
  - DealerCenter-hosted dealers account for 93 of the 264 recent no-photo rows (35%), 61 of them from one dealer (`carnova.deals`).
  - By comparison, DealerCenter-hosted dealers have photos on 94% of their recent listings (1,432 of 1,525).
- **Likely cause of the block: a zone-level rule on DealerCenter's Cloudflare setup that rejects non-browser clients, not our IP and not our request rate.**
  - From this machine, one `robots.txt` request each to two DealerCenter-hosted dealer sites returned Cloudflare 403 pages on the first request, with an honest User-Agent.
  - The same machine got `200` from `imagescf.dealercenter.net` seconds later.
  - Only the zone owner can say which rule fired, from the Ray ID. See [Diagnosing the block](#diagnosing-the-block).
- **Recommendation:**
  1. Do nothing to the scraper. Let normal re-sighting backfill the 14,949 legacy rows, and add a one-line log of why a listing has no photo.
  2. Test Auto.dev's free Vehicle Photos API on the residual 4-5%.
  3. Only if a dealer-page fetch is ever truly needed, ask DealerCenter for a feed or an allowlist instead of trying to get past the block.

## The current flow

- **Where listings and photo URLs come from.**
  - One source: MarketCheck `/v2/search/car/active`, 3 targets (`cars`, `trucks`, `suvs`) x 5 calls x 50 rows per daily run (`scraper/data_ingest.py:436-437`, `scraper/data_ingest.py:365`).
  - `map_listing` keeps the first `https` link in `media.photo_links` that is not a "not available"-style placeholder and does not mention `api_key` or `marketcheck` (`scraper/data_ingest.py:241-247`, `scraper/data_ingest.py:273-274`). It stores one URL in `car_listings.photo_url` (`db/models.py:56`).
  - MarketCheck's own cached copies (`photo_links_cached`) are deliberately dropped because their URLs embed our API key (`scraper/data_ingest.py:241-243`; the sample file confirms it, see [Side note](#side-note)).
- **When photos are written.**
  - `photo_url` is written on insert and, for existing rows, only when a later run sees the listing again and the new value is non-null (`db/repository.py:57-69`).
  - Column capture began 2026-10-30 (commit `a3b158c`, "Capture each listing's first photo for the dashboard").
- **How fast legacy rows get re-seen.**
  - Each zip comes round about every 15 days (`scheduler/runner.py:31`). Listings unseen for 60 days are deactivated (`scheduler/runner.py:37`, `scheduler/runner.py:137`).
  - Since 10-30, 2,301 legacy rows were re-seen, roughly 255 a day (SQL below). At that pace the remaining 14,949 take about 58 days, which is the 60-day deactivation window. Many will drop out of the active set before they ever get a photo.
- **When the scraper fetches a dealer page.** Never. `dealer_sites.find_down` opens a TCP connection to port 443 (then 80 on retry) and closes it, with no TLS handshake or HTTP request (`scraper/dealer_sites.py:28-47`, called from `scheduler/runner.py:228-230`).
- **How the browser gets the image.** The React app hotlinks the stored URL with `referrerPolicy="no-referrer"` (`frontend/src/components/ui.jsx:56-60`), and the home page hides cards with no photo (`frontend/src/car-intel-dashboard.jsx:221`). No server-side image fetch or cache exists.
- **The 403 mentioned in commit `00098c8`** was a dealer placeholder image that "403s off-site", i.e. a hotlink-protection response, not our scraper.

## The gap, measured (2026-11-08)

All queries: `sqlite3 -cmd ".timeout 30000" car_intel.db "..."`. A listing counts as missing when `photo_url IS NULL OR photo_url = ''`.

```sql
-- Overall
SELECT count(*), sum(is_active), sum(photo_url IS NOT NULL AND photo_url != '') FROM car_listings;
-- 34,697 rows, 22,074 active, 6,265 with a photo

-- Active listings by recency of last sighting
SELECT count(*), sum(photo_url IS NULL OR photo_url='') FROM car_listings WHERE is_active=1 AND last_seen <  '2026-10-30';  -- 14,949 / 14,949
SELECT count(*), sum(photo_url IS NULL OR photo_url='') FROM car_listings WHERE is_active=1 AND last_seen >= '2026-10-31';  --  5,911 /    264

-- Newly found since capture began
SELECT count(*), sum(photo_url IS NULL OR photo_url='') FROM car_listings WHERE first_seen >= '2026-10-31';                  --  3,610 /    125

-- By source (active, last_seen >= 2026-10-31)
SELECT scrape_source, count(*), sum(photo_url IS NULL) FROM car_listings
 WHERE is_active=1 AND last_seen >= '2026-10-31' GROUP BY 1;
-- cars 1,906 / 102 (5.4%); suvs 2,020 / 90 (4.5%); trucks 1,985 / 72 (3.6%)

-- By dealer-site host (active, last_seen >= 2026-10-31)
WITH h AS (SELECT CASE WHEN instr(substr(url,instr(url,'//')+2),'/')>0
                       THEN substr(url,instr(url,'//')+2,instr(substr(url,instr(url,'//')+2),'/')-1)
                       ELSE substr(url,instr(url,'//')+2) END host, photo_url
           FROM car_listings WHERE is_active=1 AND last_seen >= '2026-10-31')
SELECT host, count(*), sum(photo_url IS NULL OR photo_url='') m FROM h GROUP BY host ORDER BY m DESC LIMIT 4;

-- Photos already on DealerCenter's image CDN
SELECT count(*), sum(photo_url LIKE '%imagescf.dealercenter.net%') FROM car_listings
 WHERE is_active=1 AND last_seen >= '2026-10-31';                                                                           -- 5,911 / 1,436
```

| Slice (active listings) | Rows | No photo | Share |
|---|---|---|---|
| Last seen before 2026-10-30 (never re-fetched since capture began) | 14,949 | 14,949 | 100% |
| Last seen on or after 2026-10-31 | 5,911 | 264 | 4.5% |
| All active | 22,074 | 15,809 | 71.6% |

- **Of the 14,949 legacy rows,** 1,870 carry the retired source name `used_cars`; the rest are `cars`, `suvs` and `trucks`.
- **Recent no-photo rows by dealer host (top 6 of 264):** `carnova.deals` 61 of 200, `lastorresautosales.com` 36 of 36, `paramountmotorsnw.com` 19 of 19, `juniorsautosalesaz.com` 18 of 20, `rivian.com` 17 of 17, `pacificcarsandtrucks.com` 14 of 14. The tail is many small dealers.
- **No listing URL is on `dealercenterwebsite.net`.** `SELECT count(*) FROM car_listings WHERE url LIKE '%dealercenterwebsite%'` returns 0. Dealers use their own domains. DealerCenter hosting shows up only in DNS (next).

### Which dealer domains are DealerCenter-hosted

`dig +short CNAME <host>` on the 135 dealer hosts that either have a `imagescf.dealercenter.net` photo or have a recent no-photo listing (DNS only; the lookups were in a scratch script, not saved to the repo):

| CNAME target | Hosts |
|---|---|
| `alpha.dcdws.net` | 96 (including `carnova.deals` and `consumersautocenter.com`) |
| `dealers.dealercenterwebsite.net` | 2 (`success-autosales.com`, `delnorteautomobile.com`) |
| Everything else or no CNAME | 37 (mostly apex-domain dealers with an A record, which a CNAME query cannot classify) |

- **`dcdws.net` is DealerCenter's too:** its nameservers are `ns1.nowcom.com` and `ns2.nowcom.com`, and Nowcom is the company behind DealerCenter ([Nowcom](https://www.nowcom.com/dealercenter/)). The Nowcom link is an inference from the NS records plus that page; I did not find a statement that `dcdws.net` belongs to DealerCenter.
- **`dealers.dealercenterwebsite.net` resolves to `dealers.dealercenterwebsite.net.cdn.cloudflare.net`.** That pattern is consistent with Cloudflare for SaaS custom hostnames, in which case DealerCenter, not the individual dealer, controls the Cloudflare rules for those sites. Unverified.
- **Join result.** Of 264 recent no-photo listings, 93 are on hosts whose CNAME points to `dcdws.net` or `dealercenterwebsite.net` (35%). That is a lower bound: apex-domain dealers cannot be classified from a CNAME lookup.

## Diagnosing the block

### What the repo can and cannot explain

- **Request rate, concurrency, retry storms:** nothing in the repo issues HTTP requests to dealer sites, so none of these can come from the pipeline. The only dealer-facing traffic is the daily TCP connect check at 32 threads, then 16 on retry (`scraper/dealer_sites.py:41-46`). It sends no HTTP request. I found nothing in Cloudflare's docs saying bare TCP connects feed bot scoring; treat that as unverified but unlikely.
- **User-Agent and headers:** no code sets one. The `requests` calls use the library default, and the MarketCheck/NHTSA calls go to APIs that do not care.
- **robots.txt:** nothing in the repo reads it, because nothing crawls.
- **So the request that got Ray ID `a57276339c27a7ef` did not come from the pipeline.** It was probably an ad hoc fetch (a script, curl or a browser tool) from this machine. I could not trace it.

### What I observed (2026-11-08, from this machine, two requests plus one image HEAD)

```text
curl -A "car-intel-research/0.1 (one-off robots.txt check; contact dpark238@gmail.com)" https://www.success-autosales.com/robots.txt
-> HTTP/2 403, server: cloudflare, title "Attention Required! | Cloudflare", set-cookie __cf_bm, cf-ray a5727f0adce6db45-SYD
curl ... https://www.perfectimageauto.com/robots.txt        (CNAME alpha.dcdws.net, 3 s later)
-> HTTP/2 403, same page, cf-ray a5727f1e59b2fd5a-SYD
curl -I https://imagescf.dealercenter.net/1920/1080/202603-91e2f53621d44aee97189ddb831433e8.jpg
-> HTTP/2 200, image/jpeg, cache-control: public, max-age=31536000, access-control-allow-origin: *, server: cloudflare
```

- **Both DealerCenter platforms block even `robots.txt`,** on the first request with an honest identifying User-Agent. So a polite crawler cannot read the rules it is supposed to follow. The site's robots.txt is therefore **unverified**.
- **The image CDN answers `200` from the same IP and egress**, with open CORS and a one-year public cache header. So our IP is not blocked at Cloudflare globally; a per-zone rule is. This weakens the "our IP was flagged" theory, though a rule keyed to IP reputation on one zone is not ruled out.
- **The page I got is titled "Attention Required! | Cloudflare", not "Sorry, you have been blocked".** I did not capture the full body, so I cannot say whether these are the same block type. Cloudflare's Error 1020 page documents a Block action on a security rule and says [WAF custom or managed rule blocks show a different block page](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1020/). Treat the exact rule type as unknown.

### What Cloudflare says can trigger a block

- **Bot score:** Cloudflare scores each request 1-99 from heuristics, machine learning on headers and session features, and JavaScript detections for headless automation. A missing or empty User-Agent scores 1 immediately. WAF custom rules can block on the score ([bot score](https://developers.cloudflare.com/bots/concepts/bot-score/)). Granular scores need Enterprise Bot Management. This is the likeliest fit for a plain `curl` or `requests` client being refused on its first request, but it is an inference.
- **Bot Fight Mode:** free, challenges traffic that matches known bot patterns, and [cannot be skipped with WAF custom rules](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/).
- **IP Access rules and WAF custom rules:** site owners can block by IP, ASN or country, and allow with an Allow rule or a Skip rule ([IP Access rules](https://developers.cloudflare.com/waf/tools/ip-access-rules/)). The default Block response is [HTTP 403](https://developers.cloudflare.com/waf/custom-rules/create-dashboard/).
- **Which one fired:** only the zone owner can tell. Cloudflare's guidance is to search Security Events by Ray ID or IP ([Error 1020](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1020/); forum confirmation in [this thread](https://community.cloudflare.com/t/sorry-you-have-been-blocked-with-ray-id-this-is-my-own-site-how-do-i-resolve/619191), which is a user report, not documentation). The block page's Ray ID is what you send them.
- **Ranking of likely causes** (inference from the above, not proven): (1) bot-score or managed rule on DealerCenter's zones against non-browser clients, most likely; (2) a WAF custom rule, e.g. on country, ASN or hosting range; (3) IP-reputation block; (4) rate-based rule, least likely given the first request was refused.

## Legitimate routes

### 1. MarketCheck, which we already pay for: photos are in the feed

- **Field:** `media.photo_links` is documented as "Array of photo URLs from dealer website"; `media.photo_links_cached` as "Array of cached photo URLs from MarketCheck" ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)).
- **Our data:** the 50-listing sample in `logs/marketcheck_sample.json` has `photo_links` on 50 of 50 listings (1 to 117 links each), and the 1,542 `imagescf.dealercenter.net` photo URLs in our DB show DealerCenter photos arrive through this field. The sample is one call, so it says nothing about fill rate across the fleet; the 4.5% residual above is the better estimate.
- **Cost:** no extra cost for `photo_links`; it rides on the search call we already make, within the free plan's 500 calls a month ([pricing](https://www.marketcheck.com/pricing)). Usage so far: 495 calls in October and 117 in the first 7 days of November (`data/api_usage.json`).
- **Cached copies:** the [Cached Image endpoint](https://docs.marketcheck.com/docs/api/cars/vehicle-listing/cached-image) is used-cars only, adds `api_key` to the URL by default (`append_api_key=false` removes it), and says "Public caching is not allowed, meaning these images should not be stored on public CDNs or shared publicly." The pricing page lists it at $0.001 per call, billed separately ([pricing](https://www.marketcheck.com/pricing)). Our site is public, so this is not a fit.
- **Filtering to listings with photos:** the search endpoint takes `photo_links=true` and `min_photo_links=N` ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). Do not add it to the training scrape: it changes which listings the price model sees. Unverified how much it would skew.
- **Re-fetching legacy rows by VIN:** the endpoint takes `vin` and `vins`; the docs say `vins` is "used in conjunction with the `match` parameter always" and state no maximum VIN count ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). Max 50 rows per call. 14,949 rows would need at least 300 calls, which is more than the roughly 50 left this month (500 minus the 450 or so the daily schedule uses). Unverified: whether `vins` works as I read it and how many VINs fit in a call.

### 2. DealerCenter's image CDN is separate from the WAF-protected sites

- **Evidence:** `imagescf.dealercenter.net` serves photos with open CORS and `public, max-age=31536000`, and returned `200` to a plain request (see above). 1,542 photos in our DB already use it, from 104 dealer hosts (`SELECT count(*), count(distinct url) FROM car_listings WHERE photo_url LIKE '%imagescf.dealercenter.net%'`).
- **Where the URLs come from:** MarketCheck. We never need the dealer page for these.
- **Terms:** I did not find DealerCenter terms covering hotlinking from third-party sites. The CORS and cache headers are what the server does, not a licence. Unverified.

### 3. DealerCenter feeds and partner access

- **What exists:** dealers send Nowcom an inventory file "including photos", "updated at least daily" ([Service Terms, section 10](https://www.dealercenter.com/service-terms-for-dealercenter-services/)). Online Ad Post Premium builds feeds to listing sites such as Autotrader, CarGurus and TrueCar ([DealerCenter](https://get.dealercenter.com/online-ad-post-premium/)); its [Digital Marketing page](https://www.dealercenter.com/digital-marketing/) says custom feeds can be set up for any site.
- **What does not:** I found no public inventory API or developer docs. The [home page](https://www.dealercenter.com) links a Partners program, and the [partners page](https://www.dealercenter.com/partners/) is an application form aimed at dealerships and service providers; it says nothing about feed or API access for third parties.
- **What that means for us:** a feed is set up per dealer, by the dealer, for a destination they choose. We could ask a dealer to add us as a destination, but that does not scale to 100+ dealers. Contact route if wanted: the partner form or 888-669-2669 (from the partners page). Whether Nowcom would grant a data licence to a free hobby site is unknown.
- **Terms on page scraping:** "page scrape" is restricted in section 4.3.3(5) for subscribers using the Dealer Website service. I read only the first 100,000 of 143,512 characters of the terms page, so I have not seen whether anything restricts third-party crawlers. Unverified.

### 4. Cloudflare's own route for crawlers

- **Verified bots:** a bot must identify itself honestly (Web Bot Auth signature, published IP list with a stable User-Agent, or reverse DNS) and be non-abusive: it "obeys `robots.txt` and crawl directives, maintains reasonable request rates" ([Verified bots](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/)). Apply through the BotBase submission form in the Cloudflare dashboard, so a Cloudflare account is needed; I did not sign up.
- **Web Bot Auth:** host an Ed25519 JWKS at `/.well-known/http-message-signatures-directory`, register it, then sign each request with `Signature-Agent`, `Signature-Input` and `Signature` headers ([Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/)).
- **Reality check:** verified status does not override a site owner. The verified-bots field needs [Enterprise Bot Management](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.bot_management.verified_bot/) on the site's side, and site owners [can still block or allow agents by policy](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/). Whether DealerCenter's zones honour verified status is unknown. For a ~100-dealer, free, low-volume hobby site, this is a lot of ceremony for photos we mostly already have.
- **Allowlisting by the site owner:** an IP Access Allow rule, or better a custom rule with Skip ([IP Access rules](https://developers.cloudflare.com/waf/tools/ip-access-rules/)). It is DealerCenter's decision, not ours.

### 5. Other compliant photo or listing providers

| Provider | Photos | Cost | Notes |
|---|---|---|---|
| [Auto.dev Vehicle Photos](https://docs.auto.dev/v2/products/vehicle-photos) | `GET https://api.auto.dev/photos/{vin}` returns `data.retail` URLs on Auto.dev's CDN; empty arrays when none | Free plan 1,000 calls a month, hard stop at the cap; Growth $299/mo plus $0.0009 per call; Scale $599/mo plus $0.0007 ([pricing](https://www.auto.dev/pricing)) | Docs: "wholesale may be empty". Commercial use, storage and caching terms are not addressed on the pricing or docs pages: check the Terms. Billing for empty results is not stated. Coverage of our VINs untested. |
| [Auto.dev Vehicle Listings](https://www.auto.dev/listings) | Primary photo with each listing | $0.0015 per call on Growth, $0.001 on Scale | Search-style source; would duplicate MarketCheck. |
| [Zylalabs VIN Image Capture](https://www.zylalabs.com/api-marketplace/other/vin+image+capture+for+vehicles+api/9168) | Photos per VIN, exterior and interior | Free trial up to 50 requests; paid tiers not checked | Marketplace reseller; source of the images and terms unverified. |
| Black Book, Cox/Autotrader, Chrome Data | Not found in search | n/a | Enterprise sales; no public docs found. Unverified. |

- **Not recommended:** stock or OEM photos (for example Volkswagen Group images via [Vehicle Images](https://drivesomethinggreater.com/products/vehicle-images)) would show a generic car, not the listed car, which misleads on a used-car site.

### 6. Behaving well, if a dealer-page fetch is ever built

Not needed today, but if it is:

- **robots.txt:** fetch and honour it. [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) says a `4xx` robots.txt means the crawler "MAY access any resources", `5xx` means "MUST assume complete disallow", and the cache should not exceed 24 hours. A Cloudflare 403 on `robots.txt` is technically a `4xx`, but it is a plain access refusal; my recommendation is to treat it as a "no", not as permission.
- **Identify honestly:** a User-Agent such as `car-intel/1.0 (+https://cars.danielpark.fyi/bot; contact@...)` with a page that explains the crawler and how to opt out. The RFC says the product token should be a substring of the User-Agent string.
- **Rate:** one request at a time per host, several seconds apart, and a hard daily cap per host. Cloudflare lists "reasonable request rates" as a verification requirement. No Cloudflare-published numeric threshold exists that I found.
- **Back off, do not retry:** on `403`, `429` or a challenge page, stop that host for 24 hours and log it. Never loop, never rotate identities.
- **Cache:** one fetch per VIN, then stored. A listing's photos rarely change, so refetching daily is waste.

## Estimated coverage gain

| Route | Cost | Rows it can fix | Expected effect |
|---|---|---|---|
| Natural re-sighting of legacy rows | $0, already running | up to 14,949 active rows | Active no-photo share falls from 71.6% toward the recent-row rate of 4.5%, over about 58 days at the current ~255 re-seen legacy rows a day. Some rows are deactivated first (60-day rule). |
| Log why a listing has no photo | One counter in `map_listing` | 0 directly | Splits the 264 into "no `photo_links` at all", "only placeholders", "only non-`https`", so the next step is aimed correctly. Today's data cannot tell them apart (`scraper/data_ingest.py:244-247` returns `None` for all three). |
| Auto.dev free Vehicle Photos on the residual | $0 up to 1,000 calls/month | the 264 recent no-photo rows, plus about 16 new ones a day (125 in the 8 days since 10-31) | New no-photo listings run to roughly 470 a month, inside the 1,000 free calls. Gain: up to 4.5 points of recent coverage; real coverage depends on a test on our VINs. |
| MarketCheck `vins` re-fetch of legacy rows | MarketCheck calls, about 300 for all | up to 14,949 | Faster than waiting, but needs more calls than the free plan has left. |
| Ask DealerCenter for an allowlist or feed | Staff time | 93 recent rows (35% of the gap) at best | Only worth it if those 93 are not already fixable via Auto.dev. |

## Recommendation

1. **Change nothing about scraping dealer sites; let the legacy rows backfill.**
   - It is free and closes the largest part of the gap: 14,949 of 15,809 missing photos.
   - Optional: if the date matters, spend spare MarketCheck calls on a `vins` re-fetch after first testing that the parameter works. Note the month's remaining budget is about 50 calls, around 2,500 VINs at 50 per call, or 17% of the legacy set.
2. **Add a reason counter in `map_listing`, then test Auto.dev's free Vehicle Photos on 50 of the recent no-photo VINs.**
   - It costs nothing and answers the remaining questions: is the residual 4.5% photo-less because the dealer uploaded none, or because we filtered it, and does a second source cover it?
   - If it covers more than about half of them, wire it in for new listings only (about 470 calls a month, under the 1,000 free cap), and read the Terms for storage and commercial use first.
3. **Do not pursue the Cloudflare block.**
   - It is a zone-level rule on DealerCenter's side, the same IP reaches their image CDN, and the photos we need are already in the MarketCheck feed.
   - If a specific need appears later: email DealerCenter with the Ray ID, an honest description of the crawler and a contact address, and ask whether they offer a feed or allowlist. Only then consider Verified Bots or Web Bot Auth, understanding it may not change a dealer zone's rules.

## Auto.dev trial

Status 2026-11-08: **run, 50 calls on the free plan.** The script (`scripts/autodev_photo_trial.py`) picked the 50 newest active listings first seen since 2026-10-31 with no photo and a 17-character VIN (first seen 2026-11-05 to 2026-11-07), 16 of them on DealerCenter-hosted sites (`carnova.deals`, `*.mycarsonline.com`).

What the docs say ([Vehicle Photos](https://docs.auto.dev/v2/products/vehicle-photos), [Getting started](https://docs.auto.dev/v2/getting-started), [Errors](https://docs.auto.dev/v2/reference/errors), [Pricing](https://www.auto.dev/pricing)):

- **Endpoint:** `GET https://api.auto.dev/photos/{vin}`; returns `data.retail`, an array of JPEG URLs (the example URLs are on `api.auto.dev/photos/retail/...`).
- **Key required:** yes. Send `Authorization: Bearer YOUR_API_KEY`. A `?apiKey=YOUR_API_KEY` query parameter also works, which the docs call suitable "only for testing or simple integrations". The script uses the header. A 401 `UNAUTHORIZED` comes back without a key.
- **No photos:** the Vehicle Photos page says the API "returns empty arrays instead of an error" (`{"data": {"retail": []}}`), but its error table also lists a 404 `RESOURCE_NOT_FOUND` ("This vehicle does not have any photos available"). The docs do not say which applies when; the script handles both as a miss and records the status codes.
- **Do empty results count against the free 1,000 calls?** Not stated anywhere I could read. The pricing page says only that 207 partial answers (from other endpoints) are "not billed and count toward no quota", and the errors page says nothing on billing for 404s or empty arrays. Assume they count. Free-plan responses carry `X-Usage-Used`, `X-Usage-Remaining` and `X-Usage-Limit` headers, which would settle it after a few calls; the script does not log them yet. The 1,000 calls are shared across VIN Decode, Listings and Photos, with a hard stop and no overage charge; the free rate limit is 5 requests a second.
- **Terms to read before wiring it in:** the [Terms](https://www.auto.dev/terms) include photos in "Automotive Data", bar reselling or redistributing it, and limit use to "internal business purposes". That may conflict with showing the images on a public site. Check with Auto.dev before using results beyond the trial.

To run it:

1. Create a free key at auto.dev (email verification only, no card), under API Keys in the dashboard.
2. Add `AUTODEV_API_KEY=...` to `.env`.
3. `PYTHONPATH=. ./venv/bin/python scripts/autodev_photo_trial.py`. It makes at most 50 calls, 1 a second, caches each response in `data/autodev_trial.json` (a rerun makes no new calls), prints the hit rate, image hosts and 3 example URLs, and does not touch the DB. It stops early on a 401, 402, 403 or 429.

Results (50 calls, responses cached in `data/autodev_trial.json`):

- **Hit rate: 29 of 50 VINs (58%) returned at least one photo.** HTTP 200 on 29, HTTP 404 on 21. The 404 body is `{"error": {"status": 404, "code": "VIN_NOT_FOUND", "error": "This vehicle does not have any photos available..."}}`, so in practice "no photos" is a 404, not the empty array the docs describe.
- **Photos per hit:** 1 on seven VINs, 3 on two, then 8 to 34 on the rest.
- **Image host:** all 29 first URLs are on `api.auto.dev` (path `/photos/retail/{VIN}-{n}.jpg`).
- **Examples:** `https://api.auto.dev/photos/retail/1GKS2HKJ8HR232932-1.jpg` (1 photo), `https://api.auto.dev/photos/retail/3GNAXKEV1KS507959-1.jpg` (1 photo), `https://api.auto.dev/photos/retail/1GYS4BKJ9KR274529-1.jpg` (10 photos).
- **By dealer host:** 4 of 16 (25%) on DealerCenter-hosted sites, 25 of 34 (74%) elsewhere. So Auto.dev covers the DealerCenter residual poorly, which also hints those rows may have no photos upstream at all.
- **Caveats:** n = 50, so the rate is roughly 58% plus or minus 14 points. Seven hits have a single photo, which may be a stock-style or low-value image; I did not view them. A bare `HEAD` on one image URL without a key returned 404 (inconclusive, since I did not test with a key or `GET`), so whether the image URLs can be hotlinked from a browser is unverified. Whether the 21 404s counted against the 1,000 free calls is still unknown; assume all 50 did. I did not read the usage headers; the script does not log them.
- **Read:** useful as a second source for new listings (about 16 new no-photo listings a day, so roughly 470 calls a month, inside the 1,000 free calls). Expect to fix about half. The Terms question above must be settled first.

## Side note

`logs/marketcheck_sample.json` contains the live MarketCheck `api_key` in all 330 `photo_links_cached` URLs. `logs/` is git-ignored (`.gitignore:15`), so it is not tracked, but do not paste the file anywhere. Consider rotating the key if the file was ever shared.

## Open questions

- What the full block page said and which rule fired: needs the Ray ID looked up in DealerCenter's Security Events, which only they can do.
- Whether the 264 recent no-photo rows have no `photo_links` upstream, only placeholders, or non-`https` links: not recorded, so not answerable from current data.
- Whether MarketCheck's `vins` parameter works without `match`, and how many VINs one call accepts.
- Auto.dev photo coverage on our VINs, and its terms on storing or caching images.
- Whether `dcdws.net` and `dealers.dealercenterwebsite.net` are both DealerCenter-controlled Cloudflare zones with the same ruleset. The DNS pattern says so; no first-party statement does.
- DealerCenter's third-party crawler terms: I read only the first 100,000 of 143,512 characters of the service terms.
- Whether any of this changes the price model: not tested; photos are not a model feature (`db/models.py:56` stores the URL only).
