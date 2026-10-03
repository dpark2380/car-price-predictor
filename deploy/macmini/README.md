# Running Car Intel on an always-on Mac mini

Moves the scheduled pipeline (scrape, retrain, rescore every 36h), the API and
the dashboard off a laptop that sleeps through its schedule. All three run as
LaunchDaemons, so they survive reboots without anyone logging in.

| Service | Label | What |
|---|---|---|
| Pipeline | `com.carintel.pipeline` | `scheduler/runner.py` every 129,600 s (36h) |
| API | `com.carintel.api` | gunicorn, 1 worker x 4 threads, port 5001, restarted if it dies |
| Dashboard | `com.carintel.web` | static `frontend/build` on port 3000 |

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
brew install python@3.14 node libomp     # libomp: XGBoost needs it on macOS
git clone git@github.com:dpark2380/Car-Price-Predictor.git ~/car-intel   # not under ~/Documents
cd ~/car-intel
./deploy/macmini/setup.sh ~/Downloads/car-intel-state-*     # bundle path only on the first run
sudo ./deploy/macmini/install.sh
```

`setup.sh` verifies the bundle's checksums, restores it, builds the venv and
the dashboard, runs `tests/test_eval.py`, and renders the plists into
`deploy/macmini/out/`. `install.sh` loads the daemons, sets the Mac to never
sleep and to restart after a power failure, and checks that the API and
dashboard answer.

The dashboard is at `http://<mini-name>.local:3000` from any machine on your
network. To reach it from outside (Tailscale, Cloudflare Tunnel), rebuild it
against that URL: `API_URL=https://.../api ./deploy/macmini/setup.sh`, then
re-run `install.sh`.

## Operating it

```bash
sudo launchctl kickstart system/com.carintel.pipeline   # run the pipeline now (calls Marketcheck)
sudo launchctl print system/com.carintel.pipeline | grep -E "state|runs|last exit"
tail -f logs/launchd_stderr.log                         # pipeline output
```

After `git pull`, restart the API so it loads the new code:
`sudo launchctl kickstart -k system/com.carintel.api`. The pipeline picks up
new code on its next run.

## Caveats

- **FileVault:** if it's on, a power cut leaves the Mac at the unlock screen
  and nothing runs until someone logs in. `install.sh` warns about it.
- **Failures are silent.** A crashed run only shows in `logs/`. A free
  dead-man's-switch ping (e.g. healthchecks.io) at the end of a run would
  email you when one is missed.
- **Rollback:** the laptop plist is in `~`. Move it back to
  `~/Library/LaunchAgents/` and `launchctl bootstrap gui/$(id -u) <plist>`,
  after unloading the mini's pipeline so only one scheduler runs.
