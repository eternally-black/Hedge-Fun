#!/usr/bin/env bash
# Is the standby actually streaming? Run every 5 min by replica-check.timer on VPS2.
#
# The container being up proves nothing, which is the whole lesson of 2026-09-08: a standby
# whose WAL receiver has died keeps answering read-only queries perfectly well, from data
# that stopped moving hours ago, and every liveness check agrees it is fine. Only
# pg_stat_wal_receiver knows.
#
# Pass -v to print the numbers instead of staying quiet.
set -u

STACK="${STACK:-/opt/standby}"
STATE_DIR="${STATE_DIR:-/var/lib/hedgefun}"
NOTIFY="${NOTIFY:-/opt/ops/ops/notify.sh}"
PGUSER_STANDBY="${PGUSER_STANDBY:-hedgefun}"
# Generous on purpose: an idle primary stalls the replay clock too, so a small lag says
# nothing. Anything past half an hour is either a stuck replay or a primary nobody is using.
MAX_LAG="${MAX_LAG:-1800}"

VERBOSE=0; [ "${1:-}" = "-v" ] && VERBOSE=1
[ -f "$STACK/docker-compose.yml" ] || exit 0   # standby not installed on this host

mkdir -p "$STATE_DIR"
notify() { bash "$NOTIFY" "$1" "$2" || true; }

# Same dedupe contract as the watchdog: absent file = fine, so the OK message fires once on
# the way out of a break and an unfixed break re-alerts at most every 30 min.
ALERT_F="$STATE_DIR/alert.replica"
report_broken() {
  local t; t=$(date +%s)
  if [ ! -f "$ALERT_F" ]; then echo "$t" > "$ALERT_F"; notify CRIT "$1"
  elif [ $(( t - $(cat "$ALERT_F") )) -ge 1800 ]; then echo "$t" > "$ALERT_F"; notify CRIT "STILL BROKEN: $1"; fi
}
report_ok() { [ -f "$ALERT_F" ] && { rm -f "$ALERT_F"; notify OK "$1"; }; return 0; }

q() { docker compose -f "$STACK/docker-compose.yml" exec -T replica \
        psql -U "$PGUSER_STANDBY" -h 127.0.0.1 -p 5433 -d postgres -Atc "$1" 2>/dev/null; }

in_recovery=$(q "select pg_is_in_recovery()")
if [ -z "$in_recovery" ]; then
  report_broken "standby replica is not answering queries at all — check 'docker compose -f $STACK/docker-compose.yml logs replica'"
  exit 1
fi
if [ "$in_recovery" != "t" ]; then
  # Promoted. Either someone ran a failover, or it was promoted by accident — both need a
  # human, because a promoted standby stops following the primary and starts diverging.
  report_broken "standby replica is NOT in recovery — it has been promoted and is no longer following VPS1"
  exit 1
fi

status=$(q "select coalesce(status,'none') from pg_stat_wal_receiver")
lag=$(q "select coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp())::bigint, -1)")
[ "$VERBOSE" = 1 ] && echo "wal_receiver=${status:-?} replay_lag=${lag:-?}s"

if [ "$status" != "streaming" ]; then
  report_broken "standby replica is not streaming (wal_receiver='${status:-none}') — replication is down, the copy is going stale"
  exit 1
fi
if [ "${lag:-0}" -gt "$MAX_LAG" ] 2>/dev/null; then
  report_broken "standby replica is streaming but ${lag}s behind (>${MAX_LAG}s) — replay is stuck"
  exit 1
fi

report_ok "standby replica is streaming again (replay lag ${lag}s)"
exit 0
