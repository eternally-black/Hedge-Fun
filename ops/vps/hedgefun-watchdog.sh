#!/usr/bin/env bash
# Container/host watchdog, run every 2 min by hedgefun-watchdog.timer as root.
# Plain Docker never restarts a container on a failing healthcheck (that is Swarm-only),
# and `compose up -d` is a no-op for a running-but-unhealthy container — so this script is
# the thing that actually closes that gap: `docker restart` for unhealthy, `compose up -d`
# for exited/missing, with restart budgets so it can never become a crashloop machine.
#
# WATCHDOG_OBSERVE=1 (default, set in /opt/hedgefun/.env) => alert-only, no restarts.
# Flip to 0 after the burn-in period. Restart budgets: 3/10min per service; db-class
# services get exactly 1 attempt per hour — a recovering Postgres must not be power-cycled.
set -u

HEDGEFUN_DIR="${HEDGEFUN_DIR:-/opt/hedgefun}"
GLITCHTIP_DIR="${GLITCHTIP_DIR:-/opt/glitchtip}"
STATE_DIR="${STATE_DIR:-/var/lib/hedgefun}"
NOTIFY="$HEDGEFUN_DIR/ops/notify.sh"
ENV_FILE="$HEDGEFUN_DIR/.env"

mkdir -p "$STATE_DIR"

# Single instance — the 2-min timer must never overlap a slow run.
exec 9>"$STATE_DIR/watchdog.lock"
flock -n 9 || exit 0

# deploy.sh holds this marker while it recreates services — don't fight a deploy.
# A marker older than 30 min is a crashed deploy; ignore it and resume watching.
MARKER="$STATE_DIR/deploy-in-progress"
if [ -f "$MARKER" ] && [ $(( $(date +%s) - $(stat -c %Y "$MARKER") )) -lt 1800 ]; then
  exit 0
fi

envval() { # envval KEY -> value from environment or /opt/hedgefun/.env (never sourced)
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(grep -E "^${1}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  fi
  printf '%s' "$v"
}

OBSERVE="$(envval WATCHDOG_OBSERVE)"; OBSERVE="${OBSERVE:-1}"
HC_URL="$(envval WATCHDOG_HC_URL)"

notify() { bash "$NOTIFY" "$1" "$2" || true; }
now() { date +%s; }

# --- deduped alert state: absent file = ok; contents = "<first_break> <last_alert>" ---
REALERT_SECS=1800
report_broken() { # report_broken <key> <message>
  local f="$STATE_DIR/alert.$1" t; t=$(now)
  if [ ! -f "$f" ]; then
    echo "$t $t" > "$f"
    notify CRIT "$2"
  else
    local last; last=$(awk '{print $2}' "$f")
    if [ $(( t - last )) -ge $REALERT_SECS ]; then
      awk -v t="$t" '{print $1, t}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      notify CRIT "STILL BROKEN: $2"
    fi
  fi
}
report_ok() { # report_ok <key> <message> — one OK alert on transition only
  local f="$STATE_DIR/alert.$1"
  if [ -f "$f" ]; then rm -f "$f"; notify OK "$2"; fi
}

# --- restart budget: newline-separated epochs per service ---
budget_ok() { # budget_ok <key> <max> <window_secs>
  local f="$STATE_DIR/restarts.$1" t cnt; t=$(now)
  [ -f "$f" ] || : > "$f"
  awk -v t="$t" -v w="$3" 't - $1 < w' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  cnt=$(wc -l < "$f")
  [ "$cnt" -lt "$2" ]
}
budget_spend() { now >> "$STATE_DIR/restarts.$1"; }

# --- step 0: the daemon itself ---
if ! docker info >/dev/null 2>&1; then
  report_broken dockerd "dockerd is not responding — attempting systemctl restart docker"
  systemctl restart docker || true
  exit 0   # next run (2 min) re-checks everything with a live daemon
fi
report_ok dockerd "dockerd is back"

# --- reconcile the declared service sets (catches missing/dead/paused, not just unhealthy) ---
# project:service:class  (class db => 1 restart/hour; std => 3/10min)
SERVICES=(
  "hedgefun:app:std" "hedgefun:poller:std" "hedgefun:db:db" "hedgefun:caddy:std"
  "glitchtip:web:std" "glitchtip:postgres:db" "glitchtip:valkey:std" "glitchtip:tg-bridge:std"
  "glitchtip:kuma:std" "glitchtip:caddy:std"
)

svc_dir() { [ "$1" = hedgefun ] && echo "$HEDGEFUN_DIR" || echo "$GLITCHTIP_DIR"; }

check_service() { # check_service <proj> <svc> <class>; returns 0 if ok
  local proj="$1" svc="$2" class="$3" dir cid state status health key="$1.$2"
  dir=$(svc_dir "$proj")
  [ -f "$dir/docker-compose.yml" ] || return 0   # stack not installed yet — not an error
  cid=$(docker ps -a --filter "label=com.docker.compose.project=$proj" \
                     --filter "label=com.docker.compose.service=$svc" -q | head -1)
  if [ -n "$cid" ]; then
    state=$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "gone|none")
  else
    state="missing|none"
  fi
  status="${state%%|*}"; health="${state##*|}"

  # healthy cases: running + (healthy|none|starting). "restarting" = docker is on it, alert only.
  if [ "$status" = running ] && { [ "$health" = healthy ] || [ "$health" = none ] || [ "$health" = starting ]; }; then
    report_ok "$key" "$proj/$svc recovered"
    return 0
  fi

  local max=3 win=600
  [ "$class" = db ] && { max=1; win=3600; }

  local action=""
  case "$status" in
    running)  action="restart" ;;               # running but unhealthy
    paused)   action="unpause" ;;
    restarting) action="" ;;                    # already being restarted by policy
    *)        action="up" ;;                    # exited/dead/created/missing
  esac

  if [ "$OBSERVE" = 1 ]; then
    report_broken "$key" "$proj/$svc is $status/$health (observe mode — no action taken)"
    return 1
  fi

  if [ -n "$action" ]; then
    if budget_ok "$key" "$max" "$win"; then
      budget_spend "$key"
      case "$action" in
        restart) docker restart "$cid" >/dev/null 2>&1 || true ;;
        unpause) docker unpause "$cid" >/dev/null 2>&1 || true ;;
        up)      ( cd "$dir" && docker compose up -d "$svc" >/dev/null 2>&1 ) || true ;;
      esac
      sleep 10
      cid=$(docker ps --filter "label=com.docker.compose.project=$proj" \
                      --filter "label=com.docker.compose.service=$svc" -q | head -1)
      if [ -n "$cid" ]; then
        health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)
        if [ "$health" = healthy ] || [ "$health" = none ] || [ "$health" = starting ]; then
          report_ok "$key" "$proj/$svc was $status/unhealthy — ${action}ed, now up"
          return 0
        fi
      fi
      report_broken "$key" "$proj/$svc was $status — ${action} attempted, still not healthy"
    else
      report_broken "$key" "$proj/$svc crashlooping (restart budget exhausted: $max per $((win/60))min) — manual intervention needed"
    fi
  else
    report_broken "$key" "$proj/$svc is $status — waiting on docker restart policy"
  fi
  return 1
}

for entry in "${SERVICES[@]}"; do
  IFS=: read -r proj svc class <<< "$entry"
  check_service "$proj" "$svc" "$class" || true
done

# --- host checks (same dedupe/re-alert machinery) ---
disk_pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "${disk_pct:-0}" -ge 95 ]; then report_broken disk "disk ${disk_pct}% full on / — act NOW"
elif [ "${disk_pct:-0}" -ge 85 ]; then report_broken disk "disk ${disk_pct}% full on /"
else report_ok disk "disk back under 85% (${disk_pct}%)"; fi

read -r mem_total mem_avail <<< "$(free -m | awk '/^Mem:/{print $2, $7}')"
if [ "${mem_total:-0}" -gt 0 ] && [ $(( mem_avail * 100 / mem_total )) -lt 5 ]; then
  report_broken mem "available RAM ${mem_avail}M of ${mem_total}M (<5%)"
else
  report_ok mem "memory pressure cleared"
fi

read -r swap_total swap_used <<< "$(free -m | awk '/^Swap:/{print $2, $3}')"
if [ "${swap_total:-0}" -gt 0 ] && [ $(( swap_used * 100 / swap_total )) -gt 70 ]; then
  report_broken swap "swap ${swap_used}M of ${swap_total}M used (>70%) — creeping memory pressure"
else
  report_ok swap "swap usage back under 70%"
fi

# --- dead-man ping: this run completed ---
if [ -n "$HC_URL" ]; then curl -fsS --max-time 10 -o /dev/null "$HC_URL" || true; fi
exit 0
