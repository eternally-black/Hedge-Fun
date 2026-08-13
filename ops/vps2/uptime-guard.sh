#!/usr/bin/env bash
# VPS2's watch on VPS1 — the external lever that can revive a hung VM. Every 2 min.
#
# CRITICAL RULE: any HTTP response — including 503 — proves VPS1 answered and counts as
# HOST ALIVE for reboot purposes (a DNS/Caddy/app failure must never power-cycle a healthy
# VM). Only a network-level failure (timeout / refused / DNS) counts toward "host down".
# Reboot fires only when ALL hold: AUTO_REBOOT=1, down >=10 min, 6h latch clear, and the
# Contabo API itself reports the instance "running" (already-restarting VMs are left alone).
# The latch is written BEFORE the restart call: a failure to record must abort, not double.
set -u

OPS_DIR="${OPS_DIR:-/opt/ops}"
STATE_DIR="${STATE_DIR:-/var/lib/hedgefun}"
ENV_FILE="$OPS_DIR/.env"
NOTIFY="$OPS_DIR/ops/notify.sh"
mkdir -p "$STATE_DIR"

exec 9>"$STATE_DIR/uptime-guard.lock"
flock -n 9 || exit 0

envval() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(grep -E "^${1}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  fi
  printf '%s' "$v"
}

HEALTH_URL="$(envval GUARD_HEALTH_URL)"; HEALTH_URL="${HEALTH_URL:-https://app.hedgeyour.fun/api/health}"
AUTO_REBOOT="$(envval AUTO_REBOOT)"; AUTO_REBOOT="${AUTO_REBOOT:-0}"
GUARD_HC_URL="$(envval GUARD_HC_URL)"
INSTANCE_ID="$(envval CONTABO_INSTANCE_ID)"

notify() { bash "$NOTIFY" "$1" "$2" || true; }
now() { date +%s; }

DOWN_F="$STATE_DIR/guard.down_since"
ALERT_F="$STATE_DIR/guard.last_alert"
LATCH_F="$STATE_DIR/guard.last_reboot"
DEGR_F="$STATE_DIR/guard.degraded_since"

http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null) || http_code=000

if [ "$http_code" != "000" ]; then
  # Host answered. Clear down-state; track degraded (non-200) separately, never reboot on it.
  if [ -f "$DOWN_F" ]; then
    notify OK "VPS1 reachable again (HTTP $http_code) — was network-down since $(cat "$DOWN_F")"
    rm -f "$DOWN_F" "$ALERT_F"
  fi
  if [ "$http_code" = "200" ]; then
    if [ -f "$DEGR_F" ]; then notify OK "VPS1 /api/health back to 200"; rm -f "$DEGR_F"; fi
  else
    if [ ! -f "$DEGR_F" ]; then
      date -u +%FT%TZ > "$DEGR_F"
      notify WARN "VPS1 /api/health returned $http_code — VM alive, NOT rebooting (app/db issue)"
    fi
  fi
else
  # Network-level failure.
  t=$(now)
  [ -f "$DOWN_F" ] || date -u +%FT%TZ > "$DOWN_F"
  down_since_epoch=$(date -u -d "$(cat "$DOWN_F")" +%s 2>/dev/null || echo "$t")
  down_for=$(( t - down_since_epoch ))
  last_alert=$(cat "$ALERT_F" 2>/dev/null || echo 0)
  # >=2 consecutive probes (~4 min at the 2-min cadence) before the first alert.
  if [ "$down_for" -ge 240 ] && [ $(( t - last_alert )) -ge 1800 ]; then
    echo "$t" > "$ALERT_F"
    notify CRIT "VPS1 UNREACHABLE at network level for $(( down_for / 60 )) min ($HEALTH_URL)"
  fi

  if [ "$AUTO_REBOOT" = "1" ] && [ "$down_for" -ge 600 ] && [ -n "$INSTANCE_ID" ]; then
    last_reboot=$(cat "$LATCH_F" 2>/dev/null || echo 0)
    if [ $(( t - last_reboot )) -ge 21600 ]; then
      CID="$(envval CONTABO_CLIENT_ID)"; CSEC="$(envval CONTABO_CLIENT_SECRET)"
      CUSER="$(envval CONTABO_API_USER)"; CPASS="$(envval CONTABO_API_PASSWORD)"
      if [ -n "$CID" ] && [ -n "$CSEC" ] && [ -n "$CUSER" ] && [ -n "$CPASS" ]; then
        token=$(curl -sS --max-time 15 -X POST \
          "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token" \
          -d "grant_type=password" -d "client_id=$CID" -d "client_secret=$CSEC" \
          --data-urlencode "username=$CUSER" --data-urlencode "password=$CPASS" \
          | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4) || token=""
        if [ -z "$token" ]; then
          notify CRIT "AUTO_REBOOT: Contabo auth FAILED — cannot reboot VPS1"
        else
          state=$(curl -sS --max-time 15 -H "Authorization: Bearer $token" \
            -H "x-request-id: $(cat /proc/sys/kernel/random/uuid)" \
            "https://api.contabo.com/v1/compute/instances/$INSTANCE_ID" \
            | grep -o '"status" *: *"[^"]*"' | head -1 | cut -d'"' -f4) || state=""
          if [ "$state" != "running" ]; then
            notify WARN "AUTO_REBOOT: instance state is '${state:-unknown}', not 'running' — leaving it alone"
          else
            echo "$t" > "$LATCH_F"   # latch BEFORE the action
            code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
              -H "Authorization: Bearer $token" \
              -H "x-request-id: $(cat /proc/sys/kernel/random/uuid)" \
              "https://api.contabo.com/v1/compute/instances/$INSTANCE_ID/actions/restart") || code=000
            if [ "$code" = "201" ]; then
              notify CRIT "AUTO_REBOOT: Contabo restart of VPS1 requested (201 = accepted, not yet recovered). Next auto-reboot no sooner than 6h."
            else
              notify CRIT "AUTO_REBOOT: Contabo restart call returned $code — check the panel NOW"
            fi
          fi
        fi
      else
        notify WARN "AUTO_REBOOT=1 but Contabo credentials incomplete in $ENV_FILE"
      fi
    fi
  fi
fi

# Dead-man for the guard itself (Kuma push monitor / healthchecks URL).
if [ -n "$GUARD_HC_URL" ]; then curl -fsS --max-time 10 -o /dev/null "$GUARD_HC_URL" || true; fi
exit 0
