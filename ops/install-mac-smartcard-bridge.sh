#!/usr/bin/env bash
set -euo pipefail

PI_SWARM_REPO="$(cd "$(dirname "$0")/.." && pwd)"
NURI_CARD_REPO="${NURI_CARD_REPO:-$HOME/Developer/nuri-passkey-prf-smartcard}"
PLIST_DST="$HOME/Library/LaunchAgents/de.emin.code.smartcard-bridge.plist"

if [[ ! -x "$NURI_CARD_REPO/.build/card-v1-python/bin/python3" ]]; then
  echo "Missing $NURI_CARD_REPO/.build/card-v1-python/bin/python3 — run prepare-fido2-baseline.sh in nuri-passkey-prf-smartcard first." >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST_DST")"
sed \
  -e "s|__NURI_CARD_REPO__|$NURI_CARD_REPO|g" \
  -e "s|__PI_SWARM_REPO__|$PI_SWARM_REPO|g" \
  "$PI_SWARM_REPO/ops/de.emin.code.smartcard-bridge.plist" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)/de.emin.code.smartcard-bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
sleep 1
curl -fsS http://127.0.0.1:4199/healthz && echo ""
