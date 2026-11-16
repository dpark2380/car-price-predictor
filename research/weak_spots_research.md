# Three weak spots: trim specs, photos, dealer reachability

Run date 2026-11-16. Scope: free or very cheap fixes for (1) trim-level US specs, (2) listing photo coverage, (3) the dealer-site check that reports 220 of 881 hosts down. CarSpecsAPI and RevCarData are excluded by the owner. I build on `research/car_specs_apis_research.md`, `research/listing_photos_research.md` and `research/free_fields_research.md` and say what is new. Repo and DB facts come from read-only queries on `car_intel.db` and `data/dealer_sites.json`. External claims link to the source. "Unverified" means I could not confirm it from a primary source or a real response. About 30 web fetches were used; no account was made and nothing was bought.

## Summary

- **Photos: the cap, not Auto.dev, is the bottleneck.** `PHOTOS_DAILY_CALLS` is 30 (`scheduler/runner.py:46`), and the free plan allows 1,000 calls a month ([pricing](https://www.auto.dev/pricing)). The 16 photos per 30 calls is the 55% hit rate (175 of 317 VINs found, from the `vin_photos` table), not a flaky API. At 16 a day, the 11,760 photo-less VINs would take about two years.
- **Photos: 93% of the gap is old rows, not missing photos.** Of 25,844 active listings, 14,213 have no photo (11,760 distinct VINs). 13,238 of them were last seen before 2026-10-30, when photo capture began. Active rows seen since 2026-10-31: 11,582, of which only 503 (4.3%) lack a photo. This repeats the earlier finding, now re-measured. Normal re-sighting (about 255 a day) is the cheapest fix and costs nothing.
- **Specs: our own data has an easy 3 to 5 point gain, and there is no good free hp or torque source.** No free source I could verify gives hp, torque and curb weight by VIN better than vPIC. EPA data has no hp or weight. Auto.dev specs need the $299/mo Growth plan.
- **Dealer check: the 220 "down" hosts are one vendor, and the failure is the same for all of them.** All 220 resolve in DNS, but no TCP connection succeeds on 443 or 80 from this machine. 184 sit on 198.185.165.0/24 (registered to CarsForSale.com), 31 on 128.136.151.0/24 and 5 elsewhere. Not one of the 661 reachable hosts shares those blocks. This looks like either a vendor outage or a firewall that drops our IP. The check cannot tell which. 3,122 of 25,844 active listings (12%) are hidden because of it.
- **Cloudflare 403s do not cause the false negatives.** The check is a TCP connect with no HTTP request (`scraper/dealer_sites.py:28-35`), so a 403, a missing HEAD method and a bad User-Agent never fire. The risk runs the other way: a host that accepts TCP but serves an error page counts as up.

## 1. Trim-level US specs

### What we have

- `vin_specs` caches vPIC decodes per VIN "squish" (`vehicle_specs.py:squish`, the first 8 characters plus the 10th). 10,474 squishes are cached. `EngineHP` is filled on 6,203 (59%), `CurbWeightLB` on 6,066 (58%), `TransmissionStyle` on 4,398 (42%). That matches the earlier 50-VIN sample (hp 56%, weight 64%).
- `car_listings` already stores MarketCheck's `drivetrain`, `transmission`, `fuel_type`, `engine_size`, `cylinders`, `doors`, `seats`, `city_mpg`, `highway_mpg`, so drivetrain and transmission are not a gap on the listing itself. The gaps are hp, torque, curb weight, dimensions and MSRP.
- MarketCheck's listing object has an `msrp` field ([free_fields_research.md](free_fields_research.md) rank 4). Its fill rate on used cars is unmeasured. Check this first, because it is free and already in the feed.

### Options

| Source | What it gives | Join key | Cost and limits | Licence | Expected coverage |
|---|---|---|---|---|---|
| Our own `vin_specs`, imputed from siblings | hp and curb weight copied from a VIN with the same year, make, model, engine size, cylinders and drivetrain | year/make/model + engine + drive | $0 | n/a | New idea. Could lift hp and weight from about 59% to roughly 75 to 85% (unverified, measure it). Trim-level weight varies by body and options, so show weight as a range or round it |
| vPIC standalone database | The same pattern data as the API, with no rate limit | VIN pattern | $0. The API page says standalone databases are downloadable ([vPIC API](https://vpic.nhtsa.dot.gov/api/)). Format and size not read | The page states no terms ([vPIC API](https://vpic.nhtsa.dot.gov/api/)); US federal data | Same 59% fill, because the gap is in the data, not the rate limit. Only useful to remove API throttling |
| EPA fueleconomy.gov `vehicles.csv` | `displ`, `cylinders`, `trany`, `drive`, `VClass`, `tCharger`, `sCharger`, `atvType`, `baseModel`; MPG | year/make/model + displ + trany + drive | $0, bulk CSV 1984 to current ([web services](https://www.fueleconomy.gov/feg/ws/index.shtml)) | The page states no licence. It is run by Oak Ridge National Lab for DOE and EPA ([web services](https://www.fueleconomy.gov/feg/ws/index.shtml)). Treat as US government data, but confirm with fueleconomy@ornl.gov (unverified) | No hp, torque, weight or MSRP in the documented fields. Only helps to verify MarketCheck's engine, drive and transmission. Low value, as `free_fields_research.md` already ranked it |
| vPIC `GetCanadianVehicleSpecifications` (already used) | Dimensions and curb weight by trim group | year/make/model | $0 | As above | Already wired in |
| Auto.dev Specifications | `baseMsrp`, `baseInvoice`, seating, features grouped into engine, measurements, drivetrain, warranty ([docs](https://docs.auto.dev/v2/products/specifications)) | VIN | Growth plan only ($299/mo) plus $0.0015 a call. Not on Free ([pricing](https://www.auto.dev/pricing)). The 1,000 free calls do not include it | Terms bar resale; "internal business purposes" ([photos research](listing_photos_research.md)) | Unknown. The docs do not name hp, torque or curb weight (unverified) |
| Auto.dev OEM Build Data | Factory trim, option codes, `optionsMsrp` | VIN | Growth plan, $0.10 a call ([page](https://auto.dev/oem-build-data)) | Same | Coverage not stated. Too costly for 11,000+ VINs |
| carapi.app | Trims, body, engine, mileage specs, colours | year/make/model | Paid only. Base $199/yr, 1,500 calls a day. No free tier on the pricing page ([pricing](https://carapi.app/pricing)) | Page says "we advise you to cache data". Commercial terms not read | hp, torque, weight and MSRP are not named on the page |
| CarQuery API | hp, torque, weight by trim (from memory) | year/make/model | Its documentation host failed with a TLS certificate error on 2026-11-16 | Unknown | Treat as defunct (unverified) |
| NHTSA datasets page | Bulk safety datasets | n/a | The page returned 403 to me ([page](https://www.nhtsa.gov/nhtsa-datasets-and-apis)) | Unchecked | Not verified. Whether NCAP files carry curb weight is unverified |
| Window sticker (Monroney) by VIN | MSRP, options, engine, transmission, MPG | VIN | Automaker endpoints. I did not find a documented public one. The NHTSA window-sticker page returned 403 | Unchecked | Unverified. Do not build on it |

I did not find a verified free dataset on Kaggle or GitHub with US trim-level hp, torque and weight and a clear licence. I did not check Wikidata (sparse per trim, in my experience, unverified).

### Ranked recommendation

1. **Impute within our own `vin_specs` and `model_specs`.** Cheapest next step: write one SQL or pandas query that, for each squish with NULL `EngineHP`, finds other squishes with the same year, make, model, `engine_size`, `cylinders` and `drivetrain` and a filled hp. Measure how many NULLs get one unique value (or a range under 5%). Show imputed values as "about". Zero API calls.
2. **Measure MarketCheck's `msrp` fill rate** on active listings, and keep it if over 50%. One `SELECT` once the column is stored; if it is not stored, one sample call from `logs/marketcheck_sample.json`.
3. **Download `vehicles.csv` and measure the match rate on the top 30 year/make/model groups**, but only to cross-check engine, drive and transmission, not to fill hp. Skip if idea 1 works.
4. **Do not buy** Auto.dev Growth, carapi.app or OEM Build Data for this. The cost is far above the value for a no-revenue site, and none documents hp, torque and weight together.

## 2. Listing photos

### What is new

- The cap is the cause. Auto.dev Free is 1,000 calls a month across VIN Decode, Listings and Photos, 5 requests a second, with a hard stop and no overage ([pricing](https://www.auto.dev/pricing)). We spend 30 a day on photos (about 900 a month). The 55% hit rate is the data, as `vin_photos` shows (found 175, not found 142).
- Backlog numbers (2026-11-16, `car_intel.db`): 25,844 active, 14,213 without a photo, 11,760 distinct VINs. 13,238 active rows have `last_seen` before 2026-10-30. Each day's scrape re-sights some of these and `upsert` fills the photo (`scraper/data_ingest.py:244`).
- MarketCheck's `vins` search parameter exists and takes a comma-separated list with `match`, but the docs state no maximum and say rows max out at 50 per call ([Inventory Search](https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)). Whether Free allows it is unverified.

### Options

| Source | What it gives | Join key | Cost and limits | Licence | Expected coverage |
|---|---|---|---|---|---|
| Re-sighting by the nightly scrape (already running) | `media.photo_links` from the dealer, free | listing | 15 calls a day inside the 500 a month budget | MarketCheck terms on display not stated in the search docs (unverified) | About 255 legacy rows a day; 96% of re-sighted rows have a photo |
| MarketCheck `vins=` + `match` search | Same photo field for named VINs | VIN | 1 call per up to 50 VINs. At 50 VINs a call, 11,760 VINs is 236 calls. Budget is 500 a month and the daily scrape uses about 450, so this would only fit by cutting scrape pages (my reading of `runner.py`, check it). Free-plan eligibility unverified | Same as above | Same hit rate as above, but only for VINs still listed. Many legacy VINs may be gone |
| Auto.dev Vehicle Photos (in use) | `data.retail` URLs on Auto.dev's CDN | VIN | Free 1,000 a month shared. Growth $299/mo plus $0.0009 a call ([pricing](https://www.auto.dev/pricing), [photos research](listing_photos_research.md)) | Terms may not allow public display ([terms](https://www.auto.dev/terms), read earlier) | 55% of tested VINs. Weak on CarsForSale and DealerCenter-hosted dealers |
| Wikimedia Commons stock photos | One representative car photo per generation, e.g. a search for "2019 Toyota Camry" returned three files, including `File:2019 Toyota Camry LE.jpg` ([API probe](https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=2019+Toyota+Camry&srnamespace=6&format=json&srlimit=3)) | year/make/model, by search | Free, unauthenticated | Per file: mostly CC BY or CC BY-SA, so each needs an attribution line and a link. Hotlink policy not verified (the Commons technical page returned 404) | Common models only. The photo is a different car than the listing, so label it "Example photo" |
| CarsXE Vehicle Images | Up to 10 photos per call by make/model/year, with angle, colour and trim filters | make/model/year | Pay per successful lookup. Prices not on the page; a "free sandbox" has unstated limits ([page](https://carsxe.com/vehicle-images)) | Its licence filter "reads license labels from the source page", so it is not a guarantee, and the page says to "check the context link before you reuse an image" ([page](https://carsxe.com/vehicle-images)) | Looks like web image search, so rights are unclear. Avoid |
| IMAGIN.studio CDN | Rendered stock images by make/model/year | make/model/year | Docs page names no free tier, key process or price ([docs](https://docs.imagin.studio/)). The pricing page could not be fetched | Unknown | Unverified. Commercial product, so probably paid |
| Dealer inventory pages (Dealer.com, DealerInspire, DealerOn and similar) | Gallery images, usually in JSON-LD or inline JSON on the listing page | the `vdp_url` we already store | Free, but needs an HTML fetch per listing | Dealer terms and robots.txt differ per site; copyright stays with the dealer | Not verified for any platform. This needs a fetch per car and runs into the vendor blocks in section 3. Not recommended |
| NHTSA, fueleconomy.gov | No images | n/a | n/a | n/a | fueleconomy.gov has none (as the earlier research found). NHTSA not found to have any |

### Ranked recommendation

1. **Do nothing new for the old rows.** Let re-sighting backfill them. The cost is zero and the quality is the dealer's own photo of that exact car. Cheapest next step: run `SELECT count(*) FROM car_listings WHERE is_active=1 AND last_seen < '2026-10-30'` weekly and watch it fall (13,238 today).
2. **Prioritise the Auto.dev quota.** Keep the 30 a day, but order by `last_seen` desc, then by listing price rank or deal score, so the cap serves cars people will see. At 55% this adds about 16 photos a day. Raising the cap to about 33 a day uses the full free plan (1,000 a month); the VIN Decode and Listings APIs are not used, so nothing else competes for the allowance (my reading of the repo, check `AUTODEV_API_KEY` usage elsewhere).
3. **Test one `vins=` call to MarketCheck** with 50 of the old no-photo VINs and see how many come back with `photo_links`. If most do, one call beats 50 Auto.dev calls. Do this once, on one call.
4. **Optional: Commons example photos for the top 30 models**, labelled as examples, with the file's licence and author shown. Do only if the owner accepts non-matching images. A blank outline is honest and cheaper.
5. **Skip** CarsXE (unclear rights) and dealer page scraping (rights, effort and the blocks in section 3).

Hotlinking note: the app hotlinks stored URLs with `referrerPolicy="no-referrer"` (`frontend/src/components/ui.jsx:56-60`). That is fine for dealer CDNs we already use. For Commons, copy files to our own host only if the licence allows (CC BY-SA means the copy keeps that licence); I did not verify Commons' hotlink rules.

## 3. Dealer-site reachability

### How the check works

- `dealer_check_job` (`scheduler/runner.py:229-236`) takes the host of every active listing URL, calls `find_down`, and saves the list to `data/dealer_sites.json`. The API hides listings on those hosts.
- `find_down` (`scraper/dealer_sites.py:38-47`): `socket.create_connection((host, 443), timeout=8)` for every host with 32 threads. Failures get one retry with a 15 second timeout on 443 then 80, with 16 threads. A host is down only if every attempt fails.
- It never sends an HTTP request or a TLS handshake. Python's `create_connection` returns a plain socket and tries each resolved address in turn ([socket docs](https://docs.python.org/3/library/socket.html#socket.create_connection)). So Cloudflare challenges (which are HTTP responses with a `cf-mitigated: challenge` header, [Cloudflare docs](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)), 403s, 405s for HEAD and user-agent blocks cannot make a host "down". These false negatives do not exist here.

### What the 220 down hosts look like (2026-11-15 run, tested 2026-11-16)

| Finding | Number |
|---|---|
| Hosts in `down` | 220 of 881 |
| Resolve in DNS (not NXDOMAIN) | 220 (via 1.1.1.1, 8.8.8.8 and the system resolver, checked on 3 hosts) |
| On 198.185.165.0/24 (registered to CarsForSale.com, `whois`) | 184 |
| On 128.136.151.0/24 (Flexential) | 31 |
| On 69.2.203.x, 69.2.213.x, 40.71.192.x | 5 |
| Of 661 reachable hosts, how many share those blocks | 0 |
| Active listings on down hosts | 3,122 of 25,844 (12%) |

- A random sample of 40 hosts all failed TCP on both 443 and 80 with `TimeoutError`, and a Chrome-style `GET` also timed out. A control, `198.185.159.144` (a different block), accepted both ports.
- `https://www.carsforsale.com/` returned HTTP 403 to `curl`, so the vendor's main site does run bot protection.
- So this is not a User-Agent, HEAD or redirect problem. Either the vendor's sites are really dead, or the vendor's network drops our home IP. A dead host list of exactly one vendor's address blocks, with no survivors in them, makes a network-level block more likely than 220 separate dealer outages, but that is an inference.

### Recommended changes

1. **Confirm with a second network, once.** Run `nc -z -G 5 198.185.165.105 443` from a phone hotspot or a cloud shell. If it connects, the check is a false negative for 25% of hosts, and we hide 12% of listings wrongly. If it does not connect, the sites are down and the check is right. This takes two minutes and settles the question.
2. **Add an HTTP stage after the TCP pass, for hosts that pass TCP only.** `requests.get(url, headers=browser_ua, timeout=(5, 10), stream=True, allow_redirects=True)`. Count any HTTP status as up, even 403, 429, 503, as it proves the host is alive. Count as down only DNS failure, connect timeout, connection reset or TLS error. Use a `(connect, read)` timeout tuple and stream the body so you read headers only ([requests timeouts](https://requests.readthedocs.io/en/latest/user/advanced/#timeouts)). Use `GET`, not `HEAD`, since a server may answer 405 with an `Allow` header ([MDN 405](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/405)). This is optional: it only adds value for hosts that accept TCP but serve a parked or error page.
3. **Add hysteresis.** Keep a `fail_count` per host in `dealer_sites.json` and hide a host only after 3 failed daily checks in a row; clear it on one success. This stops one outage or one bad run from hiding listings.
4. **Record the failure type per host** (`dns`, `timeout`, `refused`, `tls`, `http_<code>`) in the JSON, so a vendor-wide pattern shows up in the log line, e.g. "184 timeouts in 198.185.165.0/24".
5. **Do not rotate IPs or spoof headers to get past a vendor block.** If step 1 shows an IP block, ask CarsForSale.com for an allowlist or feed, as the earlier photos research advised for DealerCenter.
6. **Interim safety valve:** if the share of hosts down in one vendor block jumps above, say, 20% of all hosts, log a warning and keep showing the listings, since the listing's price and details are still valid even if the dealer's page is slow. This is a product call.

## Open questions

- Is the CarsForSale-hosted group dead, or does it block our IP? (Section 3, step 1.)
- What is MarketCheck's terms position on showing dealer photos on a public site, and does the Free plan allow `vins=` + `match`? Not stated in the search docs I read.
- What share of old no-photo VINs are still listed on MarketCheck? The one-call test in section 2 answers this.
- Imputation: how many NULL-hp squishes have a unique hp among their siblings? Only a query on `vin_specs` can say.
- Does MarketCheck's `msrp` fill used cars at a useful rate?
- Auto.dev terms on storing photo URLs and showing the images publicly. Read earlier; ask support if this grows.
- Licence statements for fueleconomy.gov and vPIC bulk data: neither page states one. Both are US federal sources, but I did not find the wording.
- Unverified: window-sticker endpoints by VIN, NHTSA NCAP curb-weight files, Wikidata trim coverage, IMAGIN.studio pricing, Commons hotlink rules, CarQuery status.
