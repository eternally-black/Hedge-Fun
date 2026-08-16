#!/usr/bin/env bash
# Telegram alert primitive. Never exits non-zero: alerting must never break its caller.
# Usage: notify.sh <INFO|WARN|CRIT|OK> <message...>
# Credentials: $TELEGRAM_BOT_TOKEN / $TELEGRAM_CHAT_ID, else parsed from /opt/hedgefun/.env.
set -u

NOTIFY_LOG="${NOTIFY_LOG:-/var/log/hedgefun-notify.log}"
SEVERITY="${1:-}"
MSG="${*:2}"
FLAT_MSG=$(printf '%s' "$MSG" | tr '\n' ' ')

log() {
  printf '%s %s %s %s\n' "$(date -u +'%Y-%m-%d %H:%M:%SZ')" "$1" "$SEVERITY" "$FLAT_MSG" \
    >> "$NOTIFY_LOG" 2>/dev/null || true
}

case "$SEVERITY" in
  INFO|WARN|CRIT|OK) ;;
  *) echo "usage: notify.sh <INFO|WARN|CRIT|OK> <message...>" >&2
     log USAGE
     exit 0 ;;
esac
if [ -z "$MSG" ]; then
  echo "usage: notify.sh <INFO|WARN|CRIT|OK> <message...>" >&2
  log USAGE
  exit 0
fi

# Credentials: env first, then /opt/hedgefun/.env via grep+cut (never source the file).
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && [ -f /opt/hedgefun/.env ]; then
  TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' /opt/hedgefun/.env 2>/dev/null \
    | head -n1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//")
fi
if [ -z "${TELEGRAM_CHAT_ID:-}" ] && [ -f /opt/hedgefun/.env ]; then
  TELEGRAM_CHAT_ID=$(grep -E '^TELEGRAM_CHAT_ID=' /opt/hedgefun/.env 2>/dev/null \
    | head -n1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//")
fi

case "$SEVERITY" in
  INFO) EMOJI='ℹ️' ;;
  WARN) EMOJI='⚠️' ;;
  CRIT) EMOJI='🚨' ;;
  OK)   EMOJI='✅' ;;
esac
MESSAGE=$(printf '%s [%s] %s\n%s\n%s\n' \
  "$EMOJI" "$SEVERITY" "$(hostname)" "$MSG" "$(date -u +'%Y-%m-%d %H:%M:%SZ')")

if [ "${NOTIFY_DRYRUN:-0}" = "1" ]; then
  echo "[dryrun] $SEVERITY: $MSG"
  log DRYRUN
  exit 0
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  log NOCONF
  exit 0
fi

# The bot token must never reach argv: /proc/<pid>/cmdline is world-readable, so any local
# process could scrape it out of a running curl. curl takes the URL from a config file on
# stdin instead; chat_id/text stay as args (not secrets) so encoding remains curl's job.
if printf 'url = "%s"\n' "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  | curl -sS --max-time 10 -X POST -K - \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MESSAGE}" >/dev/null; then
  log SENT
else
  log FAIL
fi
exit 0
