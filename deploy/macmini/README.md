# Running Car Intel on an always-on Mac mini

Moves the scheduled pipeline (scrape, retrain, rescore daily), the API and
the dashboard off a laptop that sleeps through its schedule. All three run as
LaunchDaemons, so they survive reboots without anyone logging in.

| Service | Label | What |
|---|---|---|
| Pipeline | `com.carintel.pipeline` | `scheduler/runner.py` every 86,400 s (daily) |
| API | `com.carintel.api` | gunicorn, 1 worker x 4 threads, port 5001, restarted if it dies |

## Cutover

Order matters: stop the laptop first, so no scrape lands in the old DB after
it has been copied.

**On the laptop**

```bash
launchctl bootout gui/$(id -u)/com.danielpark.carpricepredictor
mv ~/Library/LaunchAgents/com.danielpark.carpricepredictor.plist ~/   # keep it, just unloaded
./deploy/macmini/bundle-state.sh            # -> ~/Desktop/car-intel-state-YYYYMMDD-HHMM/
```

AirDrop the `car-intel-state-...` folder to the mini. It contains your
Marketcheck key (`.env`), so don't upload it anywhere else.

**On the Mac mini**

```bash
brew install python@3.14 libomp          # libomp: XGBoost needs it on macOS
git clone git@github.com:dpark2380/Car-Price-Predictor.git ~/car-intel   # not under ~/Documents
cd ~/car-intel
./deploy/macmini/setup.sh ~/Downloads/car-intel-state-*     # bundle path only on the first run
sudo ./deploy/macmini/install.sh
```

`setup.sh` verifies the bundle's checksums, restores it, builds the venv,
runs `tests/test_eval.py`, and renders the plists into
`deploy/macmini/out/`. `install.sh` loads the daemons, sets the Mac to never
sleep and to restart after a power failure, and checks that the API
answers.

The API listens on `127.0.0.1:5001` only, so the Cloudflare Tunnel (below) is
the one way in from other machines, and the dashboard lives on Cloudflare
Pages. `install.sh` removes the old LAN dashboard daemon (`com.carintel.web`).

## Public site

- Dashboard: https://cars.danielpark.fyi on Cloudflare Pages (project
  `car-price-predictor`, root `frontend`, build `npm run build`, output
  `build`, env `REACT_APP_API_URL=https://cars-api.danielpark.fyi/api`).
  Every push to `main` redeploys it.
- API: https://cars-api.danielpark.fyi through the Cloudflare Tunnel
  `mac-mini` (route -> `http://localhost:5001`). `cloudflared` runs as the
  LaunchDaemon `com.cloudflare.cloudflared`; logs in
  `/Library/Logs/com.cloudflare.cloudflared.err.log`.
- Cloudflare caches API responses for 2 hours (cache rule "Cache API") and
  rate-limits `/api/*` to 30 requests per 10 s per IP. After each full run the
  pipeline purges the cache when `.env` has `CLOUDFLARE_ZONE_ID` and a
  `CLOUDFLARE_API_TOKEN` scoped to Zone > Cache Purge on danielpark.fyi.
- Browsers may call the API only from the origins listed in `api.py`
  (`CORS(...)`); add one there if the dashboard moves.

## Operating it

```bash
sudo launchctl kickstart system/com.carintel.pipeline   # run the pipeline now (calls Marketcheck)
sudo launchctl print system/com.carintel.pipeline | grep -E "state|runs|last exit"
tail -f logs/launchd_stderr.log                         # pipeline output
```

After a code change, reload the API so it loads the new code. No sudo is
needed: gunicorn runs as your user, and HUP makes it start fresh workers
before stopping the old ones, so requests keep being served:
`pkill -HUP -o -f "gunicorn.*api:app"` (`-o`: only the oldest process, the master; a worker sent HUP just exits). Use
`sudo launchctl kickstart -k system/com.carintel.api` only if its plist
changed. The pipeline picks up new code on its next run.

## Caveats

- **FileVault:** if it's on, a power cut leaves the Mac at the unlock screen
  and nothing runs until someone logs in. `install.sh` warns about it.
- **Missed-run alerts:** set `HEALTHCHECK_URL` in `.env` to a free
  healthchecks.io check (period 1 day, grace 12 hours). Each full run pings
  it, and a crashed run pings `/fail`, so you get an email when a run fails
  or never happens, including when the Mac is off or offline. Without it,
  failures only show in `logs/`.
- **Rollback:** the laptop plist is in `~`. Move it back to
  `~/Library/LaunchAgents/` and `launchctl bootstrap gui/$(id -u) <plist>`,
  after unloading the mini's pipeline so only one scheduler runs.
