#!/bin/bash
# deploy/macmini/install.sh — run on the Mac mini with sudo, after setup.sh.
#
#   sudo ./deploy/macmini/install.sh
#
# Installs the two LaunchDaemons (pipeline daily, API),
# stops the Mac from sleeping, and turns on restart after power failure.
# Re-running is safe: each daemon is unloaded and reloaded.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
OUT="$(cd "$(dirname "$0")" && pwd)/out"
[ -f "$OUT/com.carintel.pipeline.plist" ] || { echo "Run setup.sh first" >&2; exit 1; }

# The LAN dashboard daemon was retired for Cloudflare Pages; remove it if present.
if [ -f /Library/LaunchDaemons/com.carintel.web.plist ]; then
  launchctl bootout system/com.carintel.web 2>/dev/null || true
  rm -f /Library/LaunchDaemons/com.carintel.web.plist
  echo "removed com.carintel.web"
fi

for name in pipeline api; do
  label="com.carintel.$name"
  dest="/Library/LaunchDaemons/$label.plist"
  launchctl bootout "system/$label" 2>/dev/null || true
  # bootout returns before the old process exits; bootstrapping too soon fails with error 5.
  for _ in $(seq 20); do launchctl print "system/$label" >/dev/null 2>&1 || break; sleep 0.5; done
  install -m 644 -o root -g wheel "$OUT/$label.plist" "$dest"
  launchctl bootstrap system "$dest"
  echo "loaded $label"
done

# A server that sleeps misses its schedule — the reason for this move.
pmset -a sleep 0 disksleep 0 autorestart 1
echo "power: never sleep, restart after power failure"

if fdesetup status | grep -q "On"; then
  echo "WARNING: FileVault is on. After a power cut the Mac waits at the unlock" >&2
  echo "screen and nothing runs until someone logs in. Turn it off for an" >&2
  echo "unattended server, or accept that risk." >&2
fi

sleep 5
curl -fsS -o /dev/null http://localhost:5001/api/stats && echo "API OK:       http://localhost:5001/api/stats" || echo "API not answering yet: see logs/api.log" >&2
echo
echo "The pipeline runs now (RunAtLoad), then daily. To run it again (calls Marketcheck):"
echo "  sudo launchctl kickstart system/com.carintel.pipeline"
