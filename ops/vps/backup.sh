#!/usr/bin/env bash
# Postgres backups for both stacks. Nightly via hedgefun-backup.timer; also
# `backup.sh predeploy` — a fast pre-migration snapshot invoked by deploy.sh (fatal on
# failure there: a deploy must not migrate an unbackuped real-money DB).
#
# A dump only counts after `pg_restore --list` accepts it and it clears the size floor —
# an unreadable or truncated backup alerting "success" is worse than no backup.
# Success = local dump + offsite copy; offsite failure alerts separately and withholds
# the healthchecks ping (backup is then incomplete by definition).
set -uo pipefail

HEDGEFUN_DIR="${HEDGEFUN_DIR:-/opt/hedgefun}"
GLITCHTIP_DIR="${GLITCHTIP_DIR:-/opt/glitchtip}"
BACKUP_DIR="${BACKUP_DIR:-/opt/hedgefun/backups}"
NOTIFY="$HEDGEFUN_DIR/ops/notify.sh"
MODE="${1:-nightly}"
MIN_BYTES=10000               # ponytail: static floor; switch to %-of-last-dump if DB grows
STAMP=$(date -u +%Y%m%d)

notify() { bash "$NOTIFY" "$1" "$2" || true; }
envval() { # envval <file> <key>
  [ -f "$1" ] || return 0
  grep -E "^${2}=" "$1" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

dump_one() { # dump_one <dir> <svc> <user> <db> <outname>  -> 0 on verified dump
  local dir="$1" svc="$2" user="$3" db="$4" out="$BACKUP_DIR/$5" tmp
  tmp="$out.tmp"
  if ! ( cd "$dir" && docker compose exec -T "$svc" pg_dump -Fc -U "$user" "$db" ) > "$tmp" 2>/dev/null; then
    rm -f "$tmp"; notify CRIT "backup: pg_dump failed for $5"; return 1
  fi
  local size; size=$(stat -c %s "$tmp" 2>/dev/null || echo 0)
  if [ "$size" -lt "$MIN_BYTES" ]; then
    rm -f "$tmp"; notify CRIT "backup: $5 suspiciously small (${size}B < ${MIN_BYTES}B)"; return 1
  fi
  if ! ( cd "$dir" && docker compose exec -T "$svc" pg_restore --list ) < "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"; notify CRIT "backup: $5 failed pg_restore --list verification"; return 1
  fi
  sha256sum "$tmp" | awk '{print $1}' > "$out.sha256"
  chmod 600 "$tmp" "$out.sha256"
  mv "$tmp" "$out"
  return 0
}

hf_user=$(envval "$HEDGEFUN_DIR/.env" POSTGRES_USER);   hf_user="${hf_user:-postgres}"
hf_db=$(envval "$HEDGEFUN_DIR/.env" POSTGRES_DB);       hf_db="${hf_db:-postgres}"

if [ "$MODE" = predeploy ]; then
  # Fast path: hedgefun only, keep last 3, no retention pass, no pings. Non-zero on
  # failure so deploy.sh aborts before migrating.
  out="hedgefun-predeploy-$(date -u +%Y%m%d-%H%M).dump"
  dump_one "$HEDGEFUN_DIR" db "$hf_user" "$hf_db" "$out" || exit 1
  ls -1t "$BACKUP_DIR"/hedgefun-predeploy-*.dump 2>/dev/null | tail -n +4 | while read -r f; do
    rm -f "$f" "$f.sha256" "${f%.dump}.sha256" 2>/dev/null || true
  done
  echo "[backup] predeploy snapshot: $out"
  exit 0
fi

fail=0
dump_one "$HEDGEFUN_DIR" db "$hf_user" "$hf_db" "hedgefun-$STAMP.dump" || fail=1

if [ -f "$GLITCHTIP_DIR/docker-compose.yml" ]; then
  gt_user=$(envval "$GLITCHTIP_DIR/.env" POSTGRES_USER); gt_user="${gt_user:-postgres}"
  gt_db=$(envval "$GLITCHTIP_DIR/.env" POSTGRES_DB);     gt_db="${gt_db:-postgres}"
  dump_one "$GLITCHTIP_DIR" postgres "$gt_user" "$gt_db" "glitchtip-$STAMP.dump" || fail=1
fi

# Retention: daily 7 days; Sunday dumps survive 28 days. Filename carries the date, so
# retention survives mtime changes (rsync/rclone touches).
for f in "$BACKUP_DIR"/hedgefun-2*.dump "$BACKUP_DIR"/glitchtip-2*.dump; do
  [ -f "$f" ] || continue
  d=$(basename "$f" | grep -oE '[0-9]{8}' | head -1); [ -n "$d" ] || continue
  age_days=$(( ( $(date -u +%s) - $(date -u -d "$d" +%s 2>/dev/null || echo 0) ) / 86400 ))
  dow=$(date -u -d "$d" +%u 2>/dev/null || echo 0)   # 7 = Sunday
  if [ "$age_days" -gt 28 ] || { [ "$age_days" -gt 7 ] && [ "$dow" != 7 ]; }; then
    rm -f "$f" "$f.sha256"
  fi
done

# Offsite: rclone remote `offsite:` (R2, crypt recommended — see runbook). Not configured
# yet -> WARN every night until it is (day-one checklist item). Configured but failing -> CRIT
# and NO healthchecks ping: the backup is incomplete.
offsite_ok=1
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^offsite:'; then
  if ! rclone copy "$BACKUP_DIR" "offsite:hedgefun-backups/" \
        --include "*-$STAMP.dump" --include "*-$STAMP.dump.sha256" \
        --max-duration 15m --quiet 2>/dev/null; then
    offsite_ok=0; notify CRIT "backup: offsite rclone copy FAILED (local dump is fine)"
  fi
else
  offsite_ok=0
  notify WARN "backup: offsite remote 'offsite:' not configured — dumps share the VPS failure domain"
fi

if [ "$fail" -eq 0 ]; then
  BACKUP_HC_URL=$(envval "$HEDGEFUN_DIR/.env" BACKUP_HC_URL)
  if [ "$offsite_ok" -eq 1 ] && [ -n "${BACKUP_HC_URL:-}" ]; then
    curl -fsS --max-time 10 -o /dev/null "$BACKUP_HC_URL" || true
  fi
  echo "[backup] done (offsite_ok=$offsite_ok)"
  exit 0
fi
exit 1
