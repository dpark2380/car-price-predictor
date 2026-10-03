#!/bin/bash
# deploy/macmini/setup.sh — run on the Mac mini, as your normal user (no sudo).
#
#   ./deploy/macmini/setup.sh [path-to-state-bundle]
#
# Restores the AirDropped state bundle (if given), builds the Python venv and
# the dashboard, runs the tests, and renders the launchd plists into
# deploy/macmini/out/. Then run:  sudo ./deploy/macmini/install.sh
#
# API_URL overrides the URL the dashboard calls (default: this Mac's
# .local name, port 5001). Rebuild with it if you add Tailscale or a tunnel.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/deploy/macmini"
cd "$REPO"

case "$REPO" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
    echo "Move the repo out of $REPO (e.g. ~/car-intel): macOS privacy controls" >&2
    echo "can silently block background jobs from reading Documents/Desktop/Downloads." >&2
    exit 1 ;;
esac

for tool in python3.14 npm sqlite3; do
  command -v "$tool" >/dev/null || { echo "Missing $tool (brew install python@3.14 node)" >&2; exit 1; }
done

# ── 1. State bundle ──────────────────────────────────────────────────────────
if [ $# -ge 1 ]; then
  BUNDLE="$1"
  (cd "$BUNDLE" && shasum -a 256 -c --quiet MANIFEST.sha256) || { echo "Bundle checksum mismatch" >&2; exit 1; }
  [ -e car_intel.db ] && { echo "car_intel.db already exists here; not overwriting it" >&2; exit 1; }
  cp -p "$BUNDLE/car_intel.db" .
  mkdir -p models && cp -p "$BUNDLE/models/price_predictor.joblib" models/
  cp -p "$BUNDLE/.env" .env
  cp -Rp "$BUNDLE/data" .
  [ -d "$BUNDLE/logs" ] && cp -Rp "$BUNDLE/logs" .
  echo "Restored state from $BUNDLE"
fi
for f in car_intel.db models/price_predictor.joblib .env data/api_usage.json; do
  [ -e "$f" ] || { echo "Missing $f (pass the state bundle path)" >&2; exit 1; }
done
grep -Eq '^MARKETCHECK_API_KEY=.+' .env || { echo ".env has no MARKETCHECK_API_KEY" >&2; exit 1; }
mkdir -p logs

# ── 2. Python ────────────────────────────────────────────────────────────────
[ -d venv ] || python3.14 -m venv venv
venv/bin/pip install --quiet -r requirements.txt
PYTHONPATH=. venv/bin/python -W ignore tests/test_eval.py

# ── 3. Dashboard ─────────────────────────────────────────────────────────────
API_URL="${API_URL:-http://$(scutil --get LocalHostName).local:5001/api}"
(cd frontend && npm ci --no-audit --no-fund --loglevel=error && REACT_APP_API_URL="$API_URL" npm run build >/dev/null)
echo "Dashboard built against $API_URL"

# ── 4. launchd plists ────────────────────────────────────────────────────────
mkdir -p "$HERE/out"
for name in pipeline api web; do
  sed -e "s|__REPO__|$REPO|g" -e "s|__USER__|$(id -un)|g" \
    "$HERE/com.carintel.$name.plist" > "$HERE/out/com.carintel.$name.plist"
  plutil -lint -s "$HERE/out/com.carintel.$name.plist"
done

echo
echo "Setup done. Install the services (asks for your password):"
echo "  sudo $HERE/install.sh"
