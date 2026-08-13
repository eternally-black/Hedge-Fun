#!/usr/bin/env bash
# One Telegram message on boot. Never exits non-zero.
set -u

HEDGEFUN_DIR="${HEDGEFUN_DIR:-/opt/hedgefun}"
NOTIFY="$HEDGEFUN_DIR/ops/notify.sh"

# Wait for the network (up to 12 tries, 5 s apart); proceed anyway after the last try —
# the notify attempt itself will log the failure.
for i in $(seq 1 12); do
  curl -s --max-time 5 -o /dev/null https://api.telegram.org && break
  [ "$i" -lt 12 ] && sleep 5
done

bash "$NOTIFY" WARN "VPS booted — stack should be coming up via docker restart policies. Unexpected unless a reboot/deploy was planned. uptime: $(uptime -p)"
exit 0
