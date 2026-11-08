# Getting past Cloudflare on DealerCenter-hosted sites: options, risks, and whether it would add photos

Run date 2026-11-08. Scope: the methods people use to get past a Cloudflare block, what each costs and how reliable it is, the terms and legal context, and, the question that decides everything, whether doing it would add any photos to `car_intel.db`. Follows on from `research/listing_photos_research.md`. Repo facts cite the SQL I ran against `car_intel.db` (read-only). External claims link to their primary source; "unverified" means I could not confirm it from a primary source. This is desk research only: I wrote and ran no code that touches Cloudflare, and sent no request to any DealerCenter-hosted dealer site. The only network activity was DNS lookups (`dig`) for dealer hostnames, plus fetching vendor, court and documentation pages. This is information, not legal advice.

## Summary

- **Bypassing the block would add at most 93 photos, and probably fewer.**
  - Photos in this pipeline come from MarketCheck, not dealer pages. 264 active listings last seen since 2026-10-31 have no photo; 93 of them (35%) are on DealerCenter-hosted dealer sites.
  - The 93 are 0.4% of 22,074 active listings, and 1.6% of the 5,911 recently seen ones.
  - The image CDN being reachable does not help. The CDN URL contains a per-photo hash (`.../202603-91e2f5....jpg`), so you can only build it from a page or a feed that lists it.
  - Evidence that the dealer pages have no photos either: the 93 rows have been listed 185 days on average (90 of the 93 are 30+ days) and the same dealers' other listings have photos. Untested, because testing needs a request to those sites.
- **The options all exist, but none is cheap in risk.**
  - Technical: stealth browsers, hosted unblock APIs, residential proxies, TLS-impersonating clients. Money cost at our volume is small (about 170 page fetches a month, a few dollars). Reliability is an arms race with no independent success-rate data, and the Browserless guide itself says Puppeteer is "easy to detect on its own".
  - Cloudflare's own routes (Verified Bots, Web Bot Auth) need honest identification and a Cloudflare account, and only help if the site owner's rules honour them.
  - Asking the site owner for an allowlist or feed is the only route with no legal question attached.
- **Recommendation: do not bypass.** Run the Auto.dev trial on the residual, let legacy rows backfill, and if the 93 still matter, ask DealerCenter. Ranked list at the end.

## Key question: would getting past the block add photos?

### How a listing gets a photo today

- Photo URLs come only from MarketCheck `media.photo_links` (`scraper/data_ingest.py:241-247`). The pipeline never requests a dealer web page, so the Cloudflare block on `alpha.dcdws.net` and `dealercenterwebsite.net` sites does not stop any current fetch.
- So the block can only matter for a new feature: "when MarketCheck gives no photo, fetch the dealer's page and read its photos". The question is how many photos that feature could find.

### Which photo-less recent listings are DealerCenter-hosted

Method: take every host with an active listing last seen on or after 2026-10-31 (335 hosts), run `dig +short CNAME` and `dig +short A` on each (DNS only), and call a host DealerCenter-hosted when its answer chain includes `alpha.dcdws.net` or `dealers.dealercenterwebsite.net`. 91 hosts match. A check on the shared Cloudflare edge IPs those hosts resolve to (`104.18.246-250.65`) found no other host on them, so no apex-domain DealerCenter host was missed. Two other hosts timed out on the CNAME query but resolve elsewhere.

```sql
-- per-host counts, recent active listings (the host is parsed out of car_listings.url)
SELECT CASE WHEN instr(substr(url,instr(url,'//')+2),'/')>0
            THEN substr(url,instr(url,'//')+2,instr(substr(url,instr(url,'//')+2),'/')-1)
            ELSE substr(url,instr(url,'//')+2) END AS host,
       count(*) AS n, sum(photo_url IS NULL OR photo_url='') AS missing
FROM car_listings WHERE is_active=1 AND last_seen >= '2026-10-31' GROUP BY host;

-- then, with the 91 DealerCenter hosts as an IN (...) list:
SELECT dc, count(*) n, sum(miss) miss, sum(miss AND length(vin)=17) miss_vin17 FROM (
  SELECT host IN (<dc hosts>) dc, (photo_url IS NULL OR photo_url='') miss, vin FROM <the per-listing host CTE>
) GROUP BY dc;
```

| Slice (active, last seen since 2026-10-31) | Listings | No photo | Share |
|---|---|---|---|
| DealerCenter-hosted (91 hosts) | 1,526 | 93 | 6.1% |
| Everything else (244 hosts) | 4,385 | 171 | 3.9% |
| Total | 5,911 | 264 | 4.5% |

- **All 93 have a 17-character VIN**, so every one is testable in Auto.dev (below).
- **16 DealerCenter hosts hold the 93.** `carnova.deals` has 61 of its 200 listings without a photo (the other 139 have `imagescf.dealercenter.net` photos). The rest are 1 to 5 per dealer: `usexclusivemotorcars.com` 5, `delnorteautomobile.com` 4, `consumersautocenter.com` 4, `unlimitedautodeals.com` 3, `kgmautosales.mycarsonline.com` 3, and 10 smaller ones with 1 or 2 each.
- **Using first-seen instead of last-seen:** of the 125 active listings first seen since 2026-10-31 with no photo, 46 (37%) are DealerCenter-hosted. That is about 6 a day (125 listings in 8 days is about 16 a day overall).

### How many photos could a dealer-page fetch add?

| Case | Photos added | Reasoning |
|---|---|---|
| Upper bound | 93 | Every one of the 93 dealer pages shows photos MarketCheck missed. |
| Realistic | Fewer, possibly near zero | See below. |
| Ongoing | up to about 170 a month | 46 DealerCenter rows in 8 days is about 170 a month, again an upper bound. |

Why I expect the real number to be well below 93. This is inference from our data, not a measurement:

- **MarketCheck reads the same dealer page.** `photo_links` is documented as "Array of photo URLs from dealer website" ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). If the page showed photos, MarketCheck would usually have captured them. For the same dealers it did capture them on 298 of 391 recent listings (76% of these 16 hosts' listings; 94% of the 91 hosts overall).
- **The rows are old.** Their `days_listed` averages 185 (the photo-having rows on the same 16 hosts average 313), and 90 of the 93 are 30 days or older. A "photos not uploaded yet" gap would have closed by now at MarketCheck's next crawl. Unverified: `days_listed` comes from MarketCheck, and I did not check how often it recrawls.
- **Likely reasons for no photo:** the dealer never uploaded one, uploaded only a placeholder (our code drops "not available"-style placeholders, `scraper/data_ingest.py:244-247`), or the listing is for a vehicle not yet on the lot. A dealer page would show the same gap in all three cases. Today's data cannot tell them apart; the earlier note recommended a one-line reason counter in `map_listing`.
- **Cheap test that sends no request to a dealer site:** the Auto.dev trial below uses a different upstream. If it finds photos for a good share of these VINs, the photos exist somewhere; if it finds almost none, a dealer-page fetch is unlikely to find them either. 16 of the 50 trial VINs are on `carnova.deals` or `mycarsonline.com` (DealerCenter-hosted). Result (run 2026-11-08): Auto.dev had photos for 4 of those 16 DealerCenter-hosted VINs (25%) against 25 of 34 others (74%), which fits the view that many of the 93 have no photos upstream. n is small.

Net: bypassing Cloudflare is a high-risk way to chase at most 0.4% of active listings, when the cause is probably "the dealer has no photo".

## The options

For each: how it works, cost, likely reliability against a Cloudflare managed challenge or bot-score block, and upkeep. No source I found gives an independent success rate for any of these, so reliability is my judgement from the sources' own caveats.

Cost basis: our volume if we ever built this is about 93 pages once, then about 170 a month (above). I assumed 1 to 3 MB per browser page load; that is a guess.

### 1. Headless browser with stealth patches (the Browserless guide's route)

- **How it works.** [The Browserless guide](https://www.browserless.io/blog/bypass-cloudflare-with-puppeteer) (vendor post, listed as updated 2026-09-18) lists: `puppeteer-extra` with the stealth plugin (patches `navigator.webdriver`, plugins, WebGL vendor and similar); a custom User-Agent and randomised viewport; headful mode for harder challenges; saving cookies and localStorage between runs; rotating residential proxies; detecting and solving CAPTCHAs through a third-party solver; and, when Puppeteer fails, a hosted fallback (BrowserQL `verify(type: cloudflare)`, or an unblock API).
- **What the guide admits.** Puppeteer "is easy to detect on its own"; stealth "is imperfect"; Puppeteer "can't solve Turnstile independently"; and TLS fingerprinting (JA3/JA4) and behavioural checks "can still flag sessions". It gives no success rates or prices, and its example User-Agent is Chrome 114, which is stale.
- **Projects.** [puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth): README says "It's probably impossible to prevent all ways to detect headless chromium"; copyright line ends 2023; I could not see a release date, so maintenance is unverified. [nodriver](https://github.com/ultrafunkamsterdam/nodriver): talks to Chrome directly instead of through a webdriver, README claims resistance to WAFs, includes a `cf_verify()` click helper that "only works when NOT in expert mode"; licence AGPL-3.0; the README warns recent rewrites need thorough testing. [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr): drives undetected-chromedriver to clear a challenge and returns cookies; its README says "At this time none of the captcha solvers work", and "DO NOT expose FlareSolverr to the internet"; licence MIT.
- **Cost.** Software free; you run Chrome yourself (memory-heavy per FlareSolverr's README), plus a residential proxy if the block is IP-based.
- **Reliability.** Low to medium and unstable. It passes some checks one week and fails the next, because Cloudflare updates its detections and the tools patch after the fact. Interactive Turnstile is not handled without a solver.
- **Maintenance.** High. Expect to re-test after browser or Cloudflare changes; the daily scheduler would need a failure path.

### 2. Hosted browser and unblock services (Browserless, ScrapingBee, Zyte, Bright Data)

- **How it works.** You send a URL to their API; their fleet (real browsers, proxy pools, fingerprint handling, CAPTCHA solving) returns the page. They own the arms race.
- **Prices at our volume** (about 170 requests a month):

| Service | Pricing (from vendor page) | Our cost |
|---|---|---|
| [Browserless](https://www.browserless.io/pricing) | Free 1k units a month, 2 concurrent, 2 min sessions; Prototyping $25 a month for 20k units; a unit is up to 30 s of browser time; residential proxy is 6 units per MB; each CAPTCHA solve 10 units; BrowserQL on free plan | $0 to $25 a month |
| [ScrapingBee](https://www.scrapingbee.com/pricing/) | 1,000 free credits; Hobby $19 for 75k credits; JS rendering 5 credits; premium proxy 10 or 25 credits depending on JS rendering | $19 a month Hobby, using about 4k credits |
| [Zyte API](https://www.zyte.com/pricing/) | $5 free credit; browser-rendered $1.01 to $16.08 per 1,000 pay-as-you-go by site tier (Simple to Advanced) | Under $3 a month even at the top tier |
| [Bright Data Web Unlocker](https://brightdata.com/pricing/web-unlocker) | 5K free requests a month; pay-as-you-go $1.5 per 1,000; Scale $499 a month | $0, within the free tier |

- **Reliability.** Higher than DIY, but with no independent evidence. Bright Data's FAQ says "typically 100%" and "near 100%" without defining a success; its "pay only for success" applies to pay-as-you-go and does not say what counts as a success. Browserless's page makes no success-rate claim. Zyte's tier is set per site; which tier DealerCenter's would fall in is unknown. Treat all of these as vendor claims.
- **Maintenance.** Low (an API call and a fallback). The cost is dependence on a vendor and an account.
- **Catch.** These sell the same technique as option 1; they move the legal and terms exposure to us as the customer, not away from us. Check each vendor's acceptable-use terms before buying; I did not read them.

### 3. Residential proxies

- **How it works.** Requests exit through home-ISP IPs, which defeats IP-reputation and datacentre-range blocks. It does nothing for a bot-score or challenge based on browser or TLS fingerprint.
- **Cost.** [Bright Data residential](https://brightdata.com/pricing/proxy-network/residential-proxies): $4 per GB pay-as-you-go, plans from $499 a month (141 GB); the page metadata says "from $5.88/GB", so the price is unconfirmed. At about 170 pages of 1 to 3 MB, roughly $1 to $2 a month of traffic on pay-as-you-go. It requires a KYC process (an intro video call and identity checks may be asked).
- **Reliability.** Helps only if the block is IP-based. Our own check found Cloudflare returned 403 on a first `robots.txt` request while the same IP got `200` from the DealerCenter image CDN (earlier note), which points to a rule on the sites' zone, not an IP ban. So a residential IP is unlikely to be enough alone.
- **Maintenance.** Medium: billing, rotation, failures. Residential networks have their own ethics and terms questions (how the IPs are sourced), which I did not research.

### 4. TLS-fingerprint clients (curl_cffi)

- **How it works.** [curl_cffi](https://github.com/lexiforest/curl_cffi) is a Python binding that "can impersonate browsers' TLS/JA3 and HTTP/2 fingerprints", so a plain HTTP request looks like Chrome, Safari or Firefox to the TLS layer. MIT licence, 6.8k stars, requests-style API.
- **Cost.** Free; no browser to run, so cheap in CPU.
- **Reliability.** Only for bot-score blocks driven by TLS or HTTP/2 fingerprint. Its README makes no claim to beat Cloudflare and says "For solving JavaScript challenges, see brimp"; a sponsor line says "TLS fingerprinting alone isn't enough for modern bot protection". A managed challenge needs a JS-running browser. Cloudflare's [detection engines page](https://developers.cloudflare.com/bots/concepts/bot-detection-engines/) does not mention JA3/JA4, and lists heuristics, JavaScript detections and machine learning, so TLS-only impersonation may or may not be enough; unverified.
- **Maintenance.** Medium: pin to a current browser profile and re-test, because profiles age.

### 5. Cloudflare's own routes

- **Verified bots / signed agents.** A bot must self-identify honestly (a Web Bot Auth signature, a published IP list with a stable User-Agent, or reverse DNS) and be non-abusive: it must obey `robots.txt`, keep rates reasonable and not evade site-owner preferences. Apply through the BotBase submission form in the Cloudflare dashboard (needs an account); rejections come with no reason ([Verified bots policy](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/policy/), [signed agents](https://developers.cloudflare.com/bots/concepts/bot/signed-agents/)). Cloudflare can drop a bot from its global allowlist after breaches. The docs do not say verification overrides a site owner's own rules; site owners can set block or allow policies for AI crawlers and agents.
- **Web Bot Auth.** [Reference](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/): Ed25519 key, a JWKS at `/.well-known/http-message-signatures-directory`, and `Signature`, `Signature-Input` and `Signature-Agent` headers on each request; register in the dashboard under the Bot Submission Form. Can be tested at crawltest.com.
- **Site owner allowlist.** [IP Access Allow rules or a WAF Skip rule](https://developers.cloudflare.com/waf/tools/ip-access-rules/). Only the zone owner (DealerCenter, for these sites, probably) can create one.
- **Cost.** Free, plus engineering time (key management, a public bot page, honest crawl behaviour).
- **Reliability.** High if the zone owner has chosen to let verified bots through, unknown otherwise. For a hobby site fetching a few hundred pages a month it is a lot of ceremony, and approval is discretionary.
- **Maintenance.** Low once working. Needs rate limits and `robots.txt` handling, which we would need anyway.
- **Catch.** `robots.txt` on the DealerCenter-hosted sites is itself behind the block (earlier note), so we cannot read the rules we would have to promise to follow.

## Risks

### Terms of service

- **Cloudflare.** The [Cloudflare Website Terms](https://www.cloudflare.com/website-terms/) cover Cloudflare's own websites and its free public services (such as 1.1.1.1), not the sites it protects. They ban automated bots from scraping Cloudflare's own materials unless `robots.txt` allows it, and ban circumventing limits "on the Websites or Online Services". They do not say who controls access to a customer's site. So Cloudflare's terms are not the contract that matters here; the site owner's own terms and rules are.
- **DealerCenter / Nowcom.** I now have the whole [Service Terms](https://www.dealercenter.com/service-terms-for-dealercenter-services/) (143,512 characters, fetched in two parts) and the [General Terms](https://www.dealercenter.com/general-terms-and-conditions-for-dealercenter-services/), which is the page its footer calls "Terms of Use". The search for scraping terms was done by the fetch tool's summariser, not by me line by line.
  - Section 4.3 of the Service Terms restricts a subscriber from making "any use of the Services or Service Content" on other sites or from framing, "deep link", "page scrape", mirroring them, "except as expressly permitted by Nowcom, in advance and in writing". The earlier note cited this as 4.3.3(5); this fetch placed it at 4.3.5; the exact number is unconfirmed. It is written for subscribers (dealers), about Nowcom's Services and Service Content.
  - The General Terms say nothing about scraping, crawling, bots or robots.txt, and do not address third parties or visitors to dealer sites. Section 1.2.1 bars a subscriber from working "around technical limitations in a Service".
  - Section 10.2.1 gives Nowcom a licence to dealer content, "photographs, images" included, for its advertising platforms. Section 2.1 says subscribers keep rights in Customer Data. Neither says who owns the photos on a dealer's own website.
  - **Not read:** each dealer site's own footer terms, and any DealerCenter terms for dealer-website visitors. Reading them means a request to a DealerCenter-hosted site, which this task excludes. [Nowcom's privacy page](https://www.nowcom.com/privacy/) returned HTTP 403 to my fetch.
- **Net.** I found no clause that binds a third-party visitor, but I could not read the part that most likely does (the dealer sites' own terms). Absence of a clause is not permission.

### Copyright on dealer photos

- Photographs are "original works of authorship fixed in any tangible medium" ([17 U.S.C. 102(a)](https://www.copyright.gov/title17/92chap1.html)), and the owner has the exclusive rights to reproduce and display them ([section 106](https://www.copyright.gov/title17/92chap1.html)). The owner may be the dealer, a staff photographer, a photo service, or a manufacturer; I found no source saying which.
- Today we store only a URL and hotlink it with `referrerPolicy="no-referrer"` (`frontend/src/components/ui.jsx:56-60`); we do not copy the image. Whether embedding by link is a "display" is a separate question that US courts have treated differently by circuit; I did not research it this session.
- Copying images to our own storage, which a dealer-page fetch would tempt us to do, is reproduction. Fair use ([section 107](https://www.copyright.gov/title17/92chap1.html), four factors including commercial purpose and market effect) is a defence argued after the fact, not a licence. The same applies to Auto.dev's images (below): its [Terms](https://www.auto.dev/terms) bar reselling or redistributing its "Automotive Data", photos included, and limit use to "internal business purposes", which may conflict with showing them publicly.

### Legal context for circumventing a technical access control

- **CFAA, Van Buren.** [Van Buren v. United States](https://www.law.cornell.edu/supremecourt/text/19-783) (Supreme Court, decided 2021-06-03; 593 U.S. 374) read the CFAA's "exceeds authorized access" as a "gates-up-or-down inquiry—one either can or cannot access a computer system". Footnote 8 expressly leaves open whether that turns "only on technological" limits or also on contracts and policies. A Cloudflare block or challenge looks like a technological gate that is down for our client; whether a 403 challenge page counts is unsettled, and I found no ruling on Cloudflare specifically.
- **hiQ v. LinkedIn.** The Ninth Circuit reaffirmed on remand after Van Buren, [hiQ Labs v. LinkedIn, 31 F.4th 1180 (9th Cir. Apr. 18, 2022)](https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf), affirming a preliminary injunction that kept LinkedIn from blocking hiQ's scraping of public profiles, on the view that the CFAA's "without authorization" concept does not reach data open to the public. Caveats: it is a preliminary-injunction ruling, not a final one; it is Ninth Circuit law only; it involved public pages with no technical block deliberately cleared; and in November 2022 the district court held that hiQ had breached LinkedIn's User Agreement, after which the parties settled. **I could not open the opinion itself** (the court's server certificate had expired when I tried, and I did not disable verification), so this paragraph relies on a secondary summary ([Wikipedia](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn)). Read the opinion before relying on it.
- **Contract.** [Meta v. Bright Data](https://www.fbm.com/data-analytics/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/) (N.D. Cal., Jan. 23, 2024, Judge Chen): Meta's terms could not be read to bar logged-off scraping of public data, because a logged-off scraper is not a "user". Secondary source; a narrow ruling on one platform's terms; Meta later dropped the suit. It says nothing about getting around a technical block.
- **DMCA 1201.** [17 U.S.C. 1201(a)(1)(A)](https://www.law.cornell.edu/uscode/text/17/1201) says "No person shall circumvent a technological measure that effectively controls access to a work protected under this title"; "circumvent" includes to "avoid, bypass, remove, deactivate, or impair", and a measure "effectively controls access" when it "requires the application of information, or a process or a treatment, with the authority of the copyright owner". Whether a Cloudflare bot challenge on a page of copyrighted dealer photos meets that definition is, as far as I found, untested. I flag it as a risk, not a conclusion.
- **Other exposure not researched:** state computer-crime laws, trespass to chattels, and the vendors' own terms if we buy an unblock service.
- **Practical point.** Whatever the case law, getting past a block that the owner put there is the fact pattern most likely to turn a low-stakes scraping question into a dispute, and it can get our MarketCheck or hosting accounts into trouble. Honest identification and asking permission remove most of that.

## Ranked recommendation

1. **Do not pursue the bypass. Run the Auto.dev trial now.**
   - It tests the cheap, compliant source on the actual photo-less VINs, and its result also tells us whether the 93 DealerCenter rows have photos anywhere.
   - Status and how to run it are in `research/listing_photos_research.md`. It needs a free key.
2. **Let normal re-sighting backfill the 14,949 legacy rows, and add the reason counter in `map_listing`.** That closes most of the gap at no cost (previous note) and shows why the residual 264 have no photo.
3. **If the 93 still matter after steps 1 and 2: ask DealerCenter.**
   - Email Nowcom with an honest description of the project, a contact address and the Ray IDs from the earlier test, and ask for a feed or an allowlist for one identified User-Agent. The partner form and phone number are in the earlier note.
   - It is the only path with no terms or legal question, and the only one that can reach rows the dealer actually has photos for.
4. **Only then, Verified Bots / Web Bot Auth,** and only if DealerCenter says its zones honour verified bots. Cheap in money, moderate in effort, and honest by construction. Needs a public bot info page and strict rate and robots handling.
5. **Hosted unblock API (Zyte, Bright Data, ScrapingBee, Browserless), as a last resort and only with the site owner's consent or a lawyer's view.** Money is trivial at our volume, but it is the circumvention case described above, for at most 93 photos.
6. **Do not build: self-run stealth browsers, FlareSolverr, residential proxies, or curl_cffi to hit these sites.** The most maintenance, the least reliable, and the same legal exposure as step 5.

## Open questions

- Whether the 93 dealer pages show any photo that MarketCheck lacks. Answering it needs a request to those sites, which was out of scope; the Auto.dev trial is the proxy.
- Why MarketCheck has no `photo_links` for them (never uploaded, placeholder only, or crawl gap). Not recorded by `map_listing` today.
- Which rule on DealerCenter's zones fires, and whether it honours Verified Bots. Only DealerCenter can say.
- The dealer sites' own terms, and the exact number of the "page scrape" clause.
- Hotlinking versus copying images under US copyright law, and the hiQ opinion text itself (needs a working source for the court PDF).
- Acceptable-use terms of any hosted unblock vendor and of residential proxy networks.
