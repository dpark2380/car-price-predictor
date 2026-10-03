#!/bin/bash
# deploy/macmini/bundle-state.sh — run on the OLD machine (laptop).
# Collects the files git doesn't carry (DB, model, .env, scraper cursors and
# quota, logs) into one folder to AirDrop to the Mac mini.
#
#   ./deploy/macmini/bundle-state.sh [output-dir]      (default: ~/Desktop)
#
# Refuses to run while the laptop's launchd job is loaded, so no scrape can
# land in the old DB after the copy (two schedulers = double Marketcheck
# calls and two diverging databases).
set -euo pipefail
cd "$(dirname "$0")/../.."

OLD_JOB="${OLD_JOB:-gui/$(id -u)/com.danielpark.carpricepredictor}"
if launchctl print "$OLD_JOB" >/dev/null 2>&1; then
  echo "The laptop job is still loaded. Stop it first, then re-run:" >&2
  echo "  launchctl bootout $OLD_JOB" >&2
  echo "  mv ~/Library/LaunchAgents/com.danielpark.carpricepredictor.plist ~/" >&2
  exit 1
fi

for f in car_intel.db models/price_predictor.joblib .env data; do
  [ -e "$f" ] || { echo "Missing $f — nothing to bundle?" >&2; exit 1; }
done

OUT="${1:-$HOME/Desktop}/car-intel-state-$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT/models"

# .backup, not cp: a consistent copy even if something has the DB open.
sqlite3 -readonly car_intel.db ".backup '$OUT/car_intel.db'"
[ "$(sqlite3 "$OUT/car_intel.db" 'pragma integrity_check')" = "ok" ] || { echo "DB copy failed integrity check" >&2; exit 1; }

cp -p models/price_predictor.joblib "$OUT/models/"
cp -p .env "$OUT/.env"
cp -Rp data "$OUT/data"
[ -d logs ] && cp -Rp logs "$OUT/logs"

(cd "$OUT" && find . -type f ! -name MANIFEST.sha256 | sort | xargs shasum -a 256 > MANIFEST.sha256)
echo "listings: $(sqlite3 "$OUT/car_intel.db" 'select count(*) from car_listings')"
echo "Bundle ready: $OUT"
echo "It contains your Marketcheck key (.env): AirDrop it, don't upload it anywhere."
