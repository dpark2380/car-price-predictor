# Putting car-intel on a public website at $0/month: deployment research

Read date for every source below: 2026-10-30 (pages fetched that day; "last_updated" dates are shown where the page itself printed one). Nothing in the repo except this file was touched. Claims I could not confirm from a primary page are listed under "Unverified" at the end and are marked "(unverified)" inline.

## Summary

The app has three awkward properties for free hosting: a 27 MB model plus ~320 MB Python env (pandas, scikit-learn, scipy, xgboost), a SQLite file that is rewritten daily, and a daily pipeline that needs 1-2 GB RAM and several minutes of multi-core CPU. Almost every free hosted tier either has ephemeral disk, too little RAM, or now requires a card or a paid plan. The Mac mini already solves all of that, so the cheapest sound design is to keep it as the origin and only add a public front door.

Recommendation: keep everything on the Mac mini, put the static frontend on Cloudflare Pages, and expose only the API (port 5001) through an outbound tunnel. Two variants:

- Strict $0: Tailscale Funnel for the API (free, no domain needed, `*.ts.net` URL) + Cloudflare Pages for the frontend. Caveats: Funnel is documented as beta with unpublished bandwidth limits, and Tailscale's free plan is non-commercial only.
- Best quality, about $10/yr: Cloudflare Tunnel (free) on a domain you register through Cloudflare Registrar at cost. A named Cloudflare Tunnel that publishes a public hostname requires a domain on Cloudflare, so it is not strictly $0.

Ranked table (rank 1 = recommended). "$0" means no charge in normal use; "card" means a payment card is needed to sign up.

| Rank | Option | $0? | Card | SQLite persists | Cold start | Fits 320 MB env + 27 MB model + pipeline | Custom domain | Commercial use | Setup effort |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Mac mini + Tailscale Funnel (API) + Cloudflare Pages (frontend) | Yes | No | Yes (local disk) | None | Yes, already runs there | Funnel: no, only `<tailnet>.ts.net`. Pages: yes | Tailscale Personal is non-commercial only | Low |
| 2 | Mac mini + Cloudflare Tunnel + Pages, own domain | Tunnel and Pages free; domain is not | Not for Tunnel/Pages (not confirmed on a primary page) | Yes | None | Yes | Yes | Allowed within Cloudflare terms (see section 1) | Low-medium |
| 3 | Oracle Cloud Always Free A1 VM (host API and run pipeline there) | Yes | Account signup page did not state it (unverified) | Yes (boot/block volume) | None | Yes: 2 OCPU + 12 GB per current page | Yes (own DNS) | Not researched | High (new host, capacity errors, idle reclamation) |
| 4 | Vercel Hobby (Flask function with DB + model bundled; Actions redeploys daily) | Yes | No (not confirmed) | No writes; read-only bundled DB, refreshed by redeploy | Yes (Python cold start, loads 27 MB model) | Borderline: 500 MB Python bundle limit | Yes (50 per project) | Non-commercial only | High |
| 5 | Google Cloud Run free tier (DB + model baked into image) | Yes within 2M requests/mo | Yes (billing account) | No (ephemeral) | Yes | Yes (memory configurable) | Yes | Allowed | High |
| 6 | GCE e2-micro Always Free VM | Yes (US regions) | Yes | Yes | None | RAM too small for pipeline (1 GB, e2-micro RAM not confirmed on fetched page) | Yes | Allowed | High |
| 7 | ngrok free dev domain + Mac mini | Yes | No | Yes | None | Yes | No (paid only) | Not stated | Low, but caps are tight |
| 8 | Render free web service | Yes | No | No: ephemeral disk | ~1 min after 15 min idle | RAM not documented (unverified) | Not researched | Not researched | Medium |
| 9 | Koyeb free instance | Yes | Yes ($29 hold) | No volumes on free | Scales to zero after 1 h | No: 512 MB RAM, 0.1 vCPU | Not researched | Not researched | Medium |
| - | Fly.io, Hugging Face Docker Spaces, PythonAnywhere free, Cloudflare Containers, AWS free plan, Azure 12-month | Not $0 or not durable | see section 3 | | | | | | Ruled out |

GitHub Actions can run the daily pipeline for free (section 4) but only matters if the Mac mini is retired. It is not needed for the recommended design.

## 1. Keep the Mac mini, expose it publicly

### 1a. Cloudflare Tunnel (cloudflared)

- What it is: `cloudflared` on the host makes outbound-only connections to Cloudflare, so no inbound port or public IP is needed. Source: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Free: Cloudflare's Zero Trust Free plan is described as $0 for up to 50 users, and Tunnel is listed as included in that product family. I only got this from search-result snippets of cloudflare.com pages (https://www.cloudflare.com/plans/ and https://www.cloudflare.com/teams-pricing/); the fetched pages did not print the plan table. Treat "Tunnel is free" as high-confidence but not directly quoted (unverified from a fetched primary page).
- Tunnel account limit: 1,000 tunnels per account, 25 active replicas per tunnel. Source: https://developers.cloudflare.com/cloudflare-one/account-limits/
- Domain requirement: to publish an app through a named tunnel "you must add a website to Cloudflare". Source: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/ . Cloudflare Registrar sells domains at registry cost with no markup, no free domains. Source: https://developers.cloudflare.com/registrar/ . So custom domain is the one non-$0 item.
- Quick Tunnels (`trycloudflare.com`, no account, no domain) are for testing and development only: 200 in-flight requests (excess gets 429), no SSE, no uptime guarantee, new random hostname every time. Not usable for a site whose frontend bakes in `REACT_APP_API_URL`. Source: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- Install on macOS: `brew install cloudflared`. Source: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ . Running it as a service on macOS was not on the page I fetched (unverified; check `cloudflared service install` in the docs before use).
- Tunnel FAQ: WebSockets supported; visitor IPs are not forwarded to the origin by default (relevant for rate limiting, see security section); "large file/video streaming" on public routes needs specific paid services. Source: https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/
- Terms: Self-Serve Subscription Agreement section 2.2.1 forbids using the Services "to provide a virtual private network or other similar proxy services", and forbids collecting credit-card data on web properties receiving Free Services; section 2.6 says Free Services carry no liability and can be discontinued by Cloudflare. Source: https://www.cloudflare.com/terms/ . The CDN service-specific term lets Cloudflare limit access if you "serve video or a disproportionate percentage of pictures, audio files, or other large files" without paid services. Source: https://www.cloudflare.com/service-specific-terms-application-services/ . JSON API plus a 1.3 MB static site is nowhere near that. I could not find a Tunnel-specific bandwidth cap or a specific section 2.8 on the pages fetched (unverified).
- Cold start: none (origin is always on). SQLite: unchanged, local disk.
- Effort: dashboard-created tunnel, one CNAME-style public hostname -> `http://localhost:5001`, run connector as a service. About 30 minutes.

### 1b. Tailscale Funnel

- Funnel is available on all plans, can only listen on ports 443, 8443 and 10000, only uses your tailnet's `*.ts.net` DNS name (no custom domains), has "non-configurable" bandwidth limits with no published numbers, and is documented as beta. Needs MagicDNS and HTTPS enabled; DNS propagation can take up to 10 minutes. On macOS the documentation says to use the open-source (non-App Store) variants. Source: https://tailscale.com/kb/1223/funnel
- Plan: Personal is $0, up to 6 users, unlimited devices, "only suitable for non-commercial use". Source: https://tailscale.com/pricing
- Fit: no domain cost, no Cloudflare account. The URL is stable (`<machine>.<tailnet>.ts.net`), so it can be baked into the frontend build. Downside: beta feature with hidden bandwidth cap; for a small personal dashboard this is probably fine.
- Cold start / SQLite: none / unchanged.

### 1c. ngrok free

- Limits per month: 1 GB data transfer, 20,000 HTTP requests; 4,000 requests/min; 3 online endpoints; one stable auto-assigned dev domain (`*.ngrok-free.app`/`.dev`). Source: https://ngrok.com/docs/pricing-limits/free-plan-limits/
- Free-tier HTML traffic shows a browser warning interstitial; bypass with the `ngrok-skip-browser-warning` header (API/programmatic traffic is not affected). Same source. A browser frontend calling the API via fetch would need to send that header.
- Custom domains and reserved/custom hostnames require a paid plan. Source: https://ngrok.com/docs/universal-gateway/domains/
- 20,000 requests/month is about 650/day, which a public dashboard that makes several API calls per page view will exhaust quickly. Fallback only.

## 2. Split: static frontend on a free static host, API via tunnel

The frontend is ~1.3 MB of static files, so every static host fits. The only real constraints are terms and CORS. The build bakes in `REACT_APP_API_URL`, so the API hostname must be stable before building (rules out quick tunnels).

| Host | Free limits relevant here | Custom domain | Commercial | Source |
|---|---|---|---|---|
| Cloudflare Pages | 500 builds/month, 20,000 files, 25 MiB per asset, 100 projects, unlimited previews; static asset requests are free and unlimited | up to 100 per project | allowed under Cloudflare terms | https://developers.cloudflare.com/pages/platform/limits/ , https://developers.cloudflare.com/pages/functions/pricing/ |
| GitHub Pages | 1 GB site, soft 100 GB/month bandwidth, 10 builds/hour | yes | not allowed for commercial-transaction sites or SaaS | https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits |
| Vercel Hobby (static) | 100 GB Fast Data Transfer, 1M CDN requests, 100 deployments/day | 50 per project | non-commercial only | https://vercel.com/docs/plans/hobby |
| Netlify Free | "300 credit limit" shown on pricing page; custom domains with SSL on Free; credit rules and pause behaviour not stated on the fetched page (unverified) | yes | AUP applies, not read in full | https://www.netlify.com/pricing/ , https://www.netlify.com/legal/terms-of-use/ |

Pick Cloudflare Pages: no per-month bandwidth meter for static assets, no commercial restriction beyond Cloudflare's general terms, and the same account can later own the tunnel.

The frontend and API can also be served from one origin through the tunnel (the Mac mini already serves `frontend/build` on port 3000 via `com.carintel.web`), which avoids CORS but ties frontend availability to home uptime and home upload bandwidth. The split is better.

## 3. Fully hosted free tiers for the Flask API

Requirements to test each against: persistent SQLite, 27 MB model, ~320 MB venv, ideally the 1-2 GB pipeline.

### Render free web service
- Spins down after 15 minutes with no inbound traffic; ~1 minute to restart. Filesystem is ephemeral: "local SQLite databases" are lost on redeploy, restart or spin-down. 750 free instance hours per workspace per month. No persistent disks. No card needed; exceeding limits without a payment method suspends the service. RAM/CPU for the free instance are not stated on that page (unverified; the repo's `render.yaml` targets this). Source: https://render.com/docs/free
- Verdict: the DB would have to be re-downloaded on every cold start and the pipeline cannot run here. Poor fit.

### Koyeb
- Free web service: 512 MB RAM, 0.1 vCPU, 2 GB SSD, Frankfurt or Washington D.C. only, one per organization, scales to zero after 1 hour of no traffic, no Volumes on free instances. Card required (a $29 pre-authorization hold). Sources: https://www.koyeb.com/docs/reference/instances , https://www.koyeb.com/docs/faqs/pricing . The pricing page also advertises a "Free 5h Postgres tier" (0.25 vCPU, 1 GB, 1 GB storage). Source: https://www.koyeb.com/pricing
- Verdict: 512 MB RAM and 0.1 vCPU cannot load pandas + xgboost + model comfortably. No.

### Fly.io
- "Fly.io does not offer a free tier." New accounts get a trial of up to 2 hours of Machine runtime or 7 days, no card for the trial, card mandatory afterwards. Smallest always-on machine (shared-cpu-1x, 256 MB) is $2.19 per 30 days; volumes are $0.15/GB/month. Source: https://docs.fly.io/about/pricing
- Verdict: not $0.

### Google Cloud Run
- Always Free: 2 million requests/month, 360,000 GiB-seconds (request-based billing, per the Google free-features page). Source: https://docs.cloud.google.com/free/docs/free-cloud-features . A web search of Google's pricing page reports 180,000 vCPU-seconds and 360,000 GiB-seconds plus 2M requests free for request-based billing (240,000 vCPU-s and 450,000 GiB-s for instance-based); I could not get the pricing page itself to render its tables via fetch, so these specific figures and the free egress allowance are not confirmed on the primary page (unverified). Pricing page: https://cloud.google.com/run/pricing
- Needs a Google Cloud billing account with a payment method (the $300 trial documents a $0-$1 authorization hold; the Always Free tier needs the same account). Charges start if you exceed the free quotas. Source: https://docs.cloud.google.com/free/docs/free-cloud-features
- Container filesystem is not persistent (general Cloud Run behaviour, not on a page I fetched; unverified). SQLite would have to be baked into the container image and the image rebuilt and redeployed after each pipeline run (the DB grows to 100-150 MB; fine for an image). Cold starts load a 27 MB model; acceptable with min instances 0.
- Verdict: technically workable as a read-only mirror, but needs a card, a deployment pipeline, and billing-alert hygiene. Not better than the Mac mini.

### Oracle Cloud Always Free
- Ampere A1: 1,500 OCPU-hours and 9,000 GB-hours per month, stated as "2 OCPUs and 12 GB of memory" for Always Free tenancies. (Older material I remember said 4 OCPU / 24 GB; the current page says 2 / 12, so use the current figure.) Two AMD micro VMs with 1 GB RAM each, 200 GB combined block storage (minimum boot volume 47 GB), 20 GB object storage. Sources: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm , https://www.oracle.com/cloud/free/
- Idle reclamation: Oracle may reclaim an instance if over a 7-day period CPU 95th percentile < 20%, network < 20%, and (A1 only) memory < 20%. A mostly idle API would meet all three; a daily 4-minute training run does not reliably prevent this. Same source.
- Capacity: "out of host capacity" errors are documented for Always Free shapes in the home region. Same source.
- Upgrading to Pay As You Go keeps Always Free resources free and only bills usage above the limits. Same source. Whether a card is required at signup was not stated on the fetched pages (unverified); Oracle commonly asks for one for identity verification.
- Verdict: only free option that comfortably runs the API, SQLite on persistent disk and even the pipeline (12 GB RAM). Cost is migrating off the Mac mini, aarch64 wheels for xgboost on Python 3.14 (not checked), and the reclamation risk. A reasonable second home if the Mac mini is ever retired.

### GCP / AWS / Azure always-free VMs
- GCP Compute Engine: 1 e2-micro VM per month in US regions, 30 GB-months standard storage, 1 GB egress. Source: https://docs.cloud.google.com/free/docs/free-cloud-features . e2-micro RAM (1 GB) is not on the fetched page (unverified); at that size the pipeline will not run and the API with xgboost plus pandas is tight. Egress of 1 GB is tiny for a public site.
- AWS: the current free model is up to $200 in credits over 6 months; the account closes itself after 6 months or when credits run out unless you convert to a paid plan. 30+ services are always free within limits. Source: https://aws.amazon.com/free/ . Not durable.
- Azure: 12 months of free monthly amounts, plus 65+ always-free services; students can skip the card. Source: https://azure.microsoft.com/en-us/pricing/free-services/ . I did not verify an always-free compute option (unverified). Not durable for VMs.

### PythonAnywhere free
- Free accounts: 100 CPU seconds, 512 MiB of disk, 1 web app with 1 worker and a 1-month expiry (must be renewed). Source: https://help.pythonanywhere.com/pages/FreeAccountsFeatures/ . Disk is too small for the venv plus DB, CPU seconds too low for xgboost inference at any volume. No.

### Hugging Face Spaces
- CPU Basic is 2 vCPU, 16 GB RAM, 50 GB disk (non-persistent), sleeps after 48 hours of inactivity. But "Gradio and Docker Spaces run on compute and require a paid plan to create"; only Static Spaces are free to everyone. Sources: https://huggingface.co/docs/hub/spaces-overview , https://huggingface.co/docs/hub/spaces-gpus
- Verdict: a Flask app needs a Docker Space, which needs a paid plan now. Ruled out.

### Cloudflare Workers / Containers
- Workers Free: 100,000 requests/day, 10 ms CPU per invocation. Source: https://developers.cloudflare.com/workers/platform/pricing/ . That cannot run a Python+xgboost stack. Containers are not on the Free plan ("N/A"); they need Workers Paid ($5/month). Source: https://developers.cloudflare.com/containers/pricing/ . (The general pricing page lists Containers allowances without flagging the paid requirement, which conflicts; the Containers page is authoritative.) Ruled out.

## 4. Running the daily pipeline for free off the Mac

Only relevant if the Mac mini goes away or you want a hosted API that gets fresh data.

- GitHub Actions, public repo: standard GitHub-hosted runners are free and unlimited; Linux runner is 4 vCPU, 16 GB RAM, 14 GB SSD. Sources: https://docs.github.com/en/billing/concepts/product-billing/github-actions , https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Actions, private repo on GitHub Free: $12/month included compute (about 2,000 standard Linux minutes), 500 MB artifact storage, 10 GB cache; runner is 2 vCPU, 8 GB RAM, 14 GB disk. Same sources. Training takes ~4 minutes on the Mac mini's cores; on 2 vCPU it would be slower (probably 8-15 minutes, my estimate, untested), which is still ~300-450 minutes/month, inside 2,000.
- Job limit is 6 hours. Source: https://docs.github.com/en/actions/reference/limits
- Schedules: minimum every 5 minutes, may be delayed under load, and in public repos scheduled workflows are disabled after 60 days without repo activity. Source: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows . A daily bot commit or release keeps it alive, but test it.
- Moving state: release assets allow up to 2 GiB per file, up to 1,000 assets per release, with no stated total-size or bandwidth cap. Source: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases . So the workflow could upload `car_intel.db` and `price_predictor.joblib` to a fixed "latest-data" release; the API host downloads them on start or on a timer. Avoid committing the DB to git (100+ MB rewritten daily bloats history). Do not use artifacts as the handoff (500 MB cap on Free and they expire).
- Secrets: store `MARKETCHECK_API_KEY` as an Actions secret. A caution on the DB itself: whether Marketcheck's terms allow publishing derived/scraped listing data in a public release or site was not researched.
- The scraped DB would also have to be loaded from the previous release at the start of each run, because runners are ephemeral.

## 5. Vercel specifically

- Hobby is free, "restricted to non-commercial personal use only". Commercial means any deployment used for financial gain of anyone involved, including ads (AdSense), payment requests, affiliate-primary sites, advertising a product or service, or being paid to build or host the site. Donations are not commercial. Sources: https://vercel.com/docs/plans/hobby , https://vercel.com/docs/limits/fair-use-guidelines . A free dashboard with no ads/affiliate links is within the rule; adding ads or lead generation to dealers would not be.
- Hobby included usage (monthly): 1,000,000 function invocations, 4 CPU-hours Active CPU, 360 GB-hrs provisioned memory, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer. Exceeding a Hobby limit means waiting 30 days to use that feature again (no overage bill). 100 deployments/day, 50 domains per project. Source: https://vercel.com/docs/plans/hobby
- Functions: 2 GB memory / 1 vCPU max on Hobby; max duration 300 s; uncompressed size 250 MB, 500 MB for Python; large functions (up to 5 GB) are in beta; request/response body limit 4.5 MB. Source: https://vercel.com/docs/functions/limitations (last updated 2026-08-24)
- Fit: Flask API plus a 27 MB model should run (2 GB memory is enough for inference). Risks: the full dependency set (pandas, numpy, scikit-learn, scipy, xgboost) may approach the 500 MB Python limit (the venv is ~320 MB on disk here, but the Vercel bundle can differ; not tested). A function's filesystem is not a place for a writable SQLite file, so the DB must be bundled and read-only, and refreshed by a redeploy from the pipeline. The pipeline cannot run on Vercel (no multi-minute multi-core training budget on Hobby: 4 CPU-hours/month, 300 s cap). `/api/predict` loading the model per cold start costs seconds.
- 4 CPU-hours of Active CPU per month is a real cap for a public API; heavy `/api/deals` pandas work could burn it.
- Vercel documents a Python Flask migration path from Render (https://vercel.com/kb/guide/migrate-a-python-api-from-render-to-vercel); I only saw the title in the related-links list, not its content (unverified).
- Verdict: usable for the frontend (excellent, but see non-commercial rule); not recommended for the API versus tunnel + Mac mini. If you want the API on Vercel, do it only with the data-in-bundle, redeploy-daily pattern from section 4.

## Recommended setup (Option 1 or 2)

Pick the tunnel by whether a ~$10/yr domain is acceptable. Steps are identical for the frontend.

1. Frontend: `REACT_APP_API_URL=https://<api-hostname> npm run build` in `frontend/` (the repo's `deploy/macmini/setup.sh` already supports `API_URL=... ./deploy/macmini/setup.sh`). Deploy `frontend/build` to Cloudflare Pages (direct upload or Git connect, build output dir `build`). Result: `https://<project>.pages.dev`. Rebuild whenever the API hostname changes.
2. API via Tailscale Funnel (strict $0): install Tailscale on the mini (open-source/CLI variant, per the docs), enable MagicDNS and HTTPS in the admin console, then `tailscale funnel --bg 5001` (serves HTTPS on 443 to `https://<mini>.<tailnet>.ts.net`). Wait for DNS (up to 10 minutes). Only 5001 is exposed; do not funnel 3000. Command syntax is from memory of the CLI; confirm against https://tailscale.com/kb/1223/funnel and `tailscale funnel --help`.
3. API via Cloudflare Tunnel (if you buy a domain): register or add the domain to Cloudflare; Zero Trust dashboard -> Networks -> Tunnels -> create tunnel -> install `cloudflared` on the mini (`brew install cloudflared`) -> add public hostname `api.<domain>` -> `http://localhost:5001`; run it as a service so it survives reboot (confirm the macOS service step in the docs; I could not fetch it). Optionally point `www.<domain>` at the Pages project.
4. Lock the origin: gunicorn should keep listening on localhost/LAN only (it does not need to be reachable from the internet); the tunnel dials out, so do not add any router port forwarding.
5. Keep `com.carintel.api` and the tunnel connector as launchd services, and keep the Healthchecks.io ping you already have for the pipeline. Add a second check that fetches the public `/api/stats` URL.

## Security notes for exposing a home machine

- Expose exactly one local port, 5001, through the tunnel. Do not expose 3000 (the Mac mini's static server) if Pages hosts the frontend, and never expose SSH, screen sharing, Remote Control or any other service. No router port forwarding: both tunnels are outbound-only (Cloudflare doc: connects "without a publicly routable IP address", https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
- Tailscale Funnel exposes only the ports you map and only to the `ts.net` name; Funnel is separate from tailnet access, but set ACLs so Funnel is allowed only on this node. Source: https://tailscale.com/kb/1223/funnel
- CORS: `api.py` currently calls `CORS(app)`, which allows every origin. Restrict it to the Pages origin (and your custom domain) before going public: `CORS(app, origins=[...])`. This only blocks browser use from other sites; it is not authentication, so rate limit as well.
- Rate-limit `/api/predict` (and the pandas-heavy `/api/deals`, `/api/listings`): the endpoint loads or runs a 27 MB XGBoost model on 1 gunicorn worker x 4 threads, so a few dozen concurrent requests can starve the whole API. Options: Flask-Limiter (new dependency) keyed on `CF-Connecting-IP` (Cloudflare Tunnel) or per-IP; Cloudflare WAF rate limiting is available on the same zone if you use a domain (limits on the Free plan not verified). Also cap input sizes, validate parameters, cache `/api/predict` for repeated identical inputs, and add a gunicorn `--timeout`. Note the Tunnel FAQ says visitor IPs are not forwarded to the origin by default, so IP-based limiting at the app needs the Cloudflare headers configured.
- Run gunicorn as an unprivileged user and keep the `.env` (Marketcheck key) outside any served directory; the API is "read-only-ish" so confirm no endpoint writes to the DB or accepts file paths; open the SQLite file read-only (`mode=ro`) in the API process.
- Do not accept payments, collect card data, or run a general proxy through Cloudflare's free services: section 2.2.1 of the Cloudflare agreement forbids it. Source: https://www.cloudflare.com/terms/
- Free services can be withdrawn: Cloudflare section 2.6 says Free Services last until Cloudflare discontinues them. Keep a note of the fallback (Oracle A1 or Cloud Run) rather than building anything that cannot be moved.
- Uptime dependencies: the site is exactly as available as the Mac mini, home internet and power; the existing `pmset` no-sleep and restart-after-power-failure settings and the Healthchecks.io ping already cover the host. Public traffic uses home upload bandwidth only for API JSON, since the frontend is on Pages.
- Marketcheck: publishing scraped listing data publicly may be restricted by their API terms. This was out of scope and not checked; read their terms before launch.

## Unverified claims (not confirmed on a fetched primary page)

1. That Cloudflare Tunnel itself is free: only seen as search snippets of cloudflare.com pages (Zero Trust Free $0 for up to 50 users, Tunnel included). The fetched plan pages did not print the table.
2. Cloudflare's "Section 2.8" non-HTML content limitation: the Self-Serve Agreement fetched has sections 2.1-2.7 only; the CDN service-specific term quote is the closest I found. No Tunnel-specific bandwidth limit found.
3. How to run `cloudflared` as a macOS service (`cloudflared service install`): the downloads page fetched only covered `brew install`.
4. Tailscale Funnel CLI flags (`tailscale funnel --bg 5001`): from memory, not read from the page.
5. Cloud Run free vCPU-seconds (180,000 / 240,000) and free egress: web-search summary of the pricing page; the pricing page's table would not render via fetch. The 2M requests and 360,000 GiB-seconds figures are on the Google free-features page. Also unverified: that Cloud Run's container filesystem is non-persistent, and that a billing account is required for the Always Free tier (the trial page documents the card hold).
6. Render free instance RAM/CPU: not documented on https://render.com/docs/free; the pricing page fetch returned no table.
7. Oracle: credit-card requirement at signup (not stated), and aarch64 wheel availability for xgboost on Python 3.14 (not checked).
8. GCE e2-micro RAM (1 GB is general knowledge, not on the fetched page); Azure always-free compute options.
9. Netlify Free: the pricing page showed "300 credit limit" but the fetched text did not say whether it is monthly or one-time, what happens when it runs out, or whether a card is needed; the Netlify Acceptable Use Policy was not read.
10. Vercel: that the bundled Python dependency set fits under 500 MB, and that Hobby needs no card, were not checked on a primary page.
11. Cloudflare Pages: card requirement not stated on the limits page; commercial-use position inferred from the general Cloudflare agreement only.
12. GitHub Pages "free for private repos" and Actions "public repo schedules disabled after 60 days" were checked (events page); the Pages private-repo question was not answered by the fetched page.
13. Runtime estimates for the pipeline on a 2 vCPU GitHub runner are my estimate, not measured.
14. Marketcheck redistribution terms: not researched.
