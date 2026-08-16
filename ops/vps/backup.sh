#!/usr/bin/env bash
# Postgres backups for both stacks. Nightly via hedgefun-backup.timer; also
# `backup.sh predeploy` — a fast pre-migration snapshot invoked by deploy.sh (fatal on
# failure there: a deploy must not migrate an unbackuped real-money DB).
#
# A dump only counts after `pg_restore --list` accepts it and it clears the size floor —
# an unreadable or truncated backup alerting "success" is worse than no backup. Once a week
# it must also survive a REAL restore (restore_drill below); the TOC check alone cannot see
# a shredded DATA section.
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

# Encryption at rest, applied BEFORE a dump can leave this host (VPS2 pull / rclone): the
# dumps carry user emails, balances and the encrypted CLOB-credential blobs. Passphrase from
# BACKUP_ENC_PASSPHRASE in /opt/hedgefun/.env (600) — keep the only other copy in the
# password manager, never on VPS2 or in the offsite bucket, or the copies decrypt themselves.
# Unset -> plaintext dumps + a nightly WARN (same "optional but nagging" shape as offsite).
# `openssl enc` has no AEAD mode; integrity is the .sha256 written beside each artifact.
BACKUP_ENC_PASSPHRASE=$(envval "$HEDGEFUN_DIR/.env" BACKUP_ENC_PASSPHRASE)
export BACKUP_ENC_PASSPHRASE          # env:, not argv — /proc/<pid>/cmdline is world-readable
ENC_EXT=""; [ -n "$BACKUP_ENC_PASSPHRASE" ] && ENC_EXT=".enc"

plaintext() { # plaintext <dumpfile> -> the pg_dump stream on stdout, decrypting if needed
  case "$1" in
    *.enc) openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE -in "$1" ;;
    *)     cat "$1" ;;
  esac
}

dump_one() { # dump_one <dir> <svc> <user> <db> <outname>  -> 0 on verified dump
  local dir="$1" svc="$2" user="$3" db="$4" out="$BACKUP_DIR/$5$ENC_EXT" tmp="$BACKUP_DIR/$5.tmp"
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
  # Verified plaintext only ever exists inside $BACKUP_DIR (0700, root) and dies here.
  if [ -n "$ENC_EXT" ]; then
    if ! openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
         -pass env:BACKUP_ENC_PASSPHRASE -in "$tmp" -out "$tmp.enc" 2>/dev/null; then
      rm -f "$tmp" "$tmp.enc"; notify CRIT "backup: encryption of $5 FAILED — nothing written"; return 1
    fi
    rm -f "$tmp"; tmp="$tmp.enc"
  fi
  sha256sum "$tmp" | awk '{print $1}' > "$out.sha256"
  chmod 600 "$tmp" "$out.sha256"
  mv "$tmp" "$out"
  return 0
}

psqlq() { # psqlq <dir> <svc> <user> <db> <sql> -> bare result on stdout, non-zero on error
  ( cd "$1" && docker compose exec -T "$2" psql -qtAX -v ON_ERROR_STOP=1 -U "$3" -d "$4" -c "$5" ) 2>/dev/null
}

restore_drill() { # restore_drill <dir> <svc> <user> <dumpfile> -> 0 if it really restores
  # The only proof a dump is restorable is restoring it: `pg_restore --list` reads the
  # archive TOC and happily exits 0 on a dump whose DATA section is corrupt. Runs on the
  # FINAL artifact, so it also proves the encrypted copy decrypts — an unopenable backup
  # is worse than none. --exit-on-error is mandatory: pg_restore otherwise logs failures,
  # counts them, and still exits 0.
  local dir="$1" svc="$2" user="$3" dump="$4" scr=hedgefun_restore_check tables rows
  # FORCE: pg_restore can leave a connection behind when it fails, and a plain DROP then fails too —
  # the scratch DB survives, next Sunday's CREATE collides with it, and the drill reports a restore
  # failure that is really just leftover state. FORCE needs PostgreSQL 13+; the stack runs 16.
  drop_scratch() { psqlq "$dir" "$svc" "$user" postgres "DROP DATABASE IF EXISTS $scr WITH (FORCE)" >/dev/null; }
  drop_scratch || return 1
  psqlq "$dir" "$svc" "$user" postgres "CREATE DATABASE $scr" >/dev/null || return 1
  if ! plaintext "$dump" | ( cd "$dir" && docker compose exec -T "$svc" \
        pg_restore --exit-on-error --no-owner --no-privileges -U "$user" -d "$scr" ) >/dev/null 2>&1; then
    drop_scratch
    return 1
  fi
  # Structure AND content: a restore that lands an empty schema is not a backup.
  tables=$(psqlq "$dir" "$svc" "$user" "$scr" \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | tr -dc '0-9')
  rows=$(psqlq "$dir" "$svc" "$user" "$scr" "SELECT count(*) FROM users" | tr -dc '0-9')
  drop_scratch
  [ "${tables:-0}" -gt 0 ] && [ "${rows:-0}" -gt 0 ]
}

hf_user=$(envval "$HEDGEFUN_DIR/.env" POSTGRES_USER);   hf_user="${hf_user:-postgres}"
hf_db=$(envval "$HEDGEFUN_DIR/.env" POSTGRES_DB);       hf_db="${hf_db:-postgres}"

if [ "$MODE" = predeploy ]; then
  # Fast path: hedgefun only, keep last 3, no retention pass, no pings. Non-zero on
  # failure so deploy.sh aborts before migrating.
  out="hedgefun-predeploy-$(date -u +%Y%m%d-%H%M).dump"
  dump_one "$HEDGEFUN_DIR" db "$hf_user" "$hf_db" "$out" || exit 1
  ls -1t "$BACKUP_DIR"/hedgefun-predeploy-*.dump* 2>/dev/null | grep -v '\.sha256$' | tail -n +4 | while read -r f; do
    rm -f "$f" "$f.sha256" "${f%.dump}.sha256" 2>/dev/null || true
  done
  echo "[backup] predeploy snapshot: $out$ENC_EXT"
  exit 0
fi

fail=0
dump_one "$HEDGEFUN_DIR" db "$hf_user" "$hf_db" "hedgefun-$STAMP.dump" || fail=1

if [ -f "$GLITCHTIP_DIR/docker-compose.yml" ]; then
  gt_user=$(envval "$GLITCHTIP_DIR/.env" POSTGRES_USER); gt_user="${gt_user:-postgres}"
  gt_db=$(envval "$GLITCHTIP_DIR/.env" POSTGRES_DB);     gt_db="${gt_db:-postgres}"
  dump_one "$GLITCHTIP_DIR" postgres "$gt_user" "$gt_db" "glitchtip-$STAMP.dump" || fail=1
fi

# Weekly restore drill (Sundays) — the dump that is about to be kept for 28 days is the one
# worth proving. A full restore is too slow to run inside the nightly window every night, so
# it rides the same day as the long-retention dump; a failure is a failed backup, not a note.
if [ "$fail" -eq 0 ] && [ "$(date -u +%u)" = 7 ]; then
  if restore_drill "$HEDGEFUN_DIR" db "$hf_user" "$BACKUP_DIR/hedgefun-$STAMP.dump$ENC_EXT"; then
    echo "[backup] weekly restore drill passed"
  else
    fail=1
    notify CRIT "backup: WEEKLY RESTORE DRILL FAILED on hedgefun-$STAMP.dump$ENC_EXT — the dumps are NOT restorable"
  fi
fi

# Retention: daily 7 days; Sunday dumps survive 28 days. Filename carries the date, so
# retention survives mtime changes (rsync/rclone touches).
for f in "$BACKUP_DIR"/hedgefun-2*.dump* "$BACKUP_DIR"/glitchtip-2*.dump*; do
  [ -f "$f" ] || continue
  case "$f" in *.sha256) continue ;; esac   # removed together with its dump
  d=$(basename "$f" | grep -oE '[0-9]{8}' | head -1); [ -n "$d" ] || continue
  age_days=$(( ( $(date -u +%s) - $(date -u -d "$d" +%s 2>/dev/null || echo 0) ) / 86400 ))
  dow=$(date -u -d "$d" +%u 2>/dev/null || echo 0)   # 7 = Sunday
  if [ "$age_days" -gt 28 ] || { [ "$age_days" -gt 7 ] && [ "$dow" != 7 ]; }; then
    rm -f "$f" "$f.sha256"
  fi
done

if [ -z "$BACKUP_ENC_PASSPHRASE" ]; then
  notify WARN "backup: BACKUP_ENC_PASSPHRASE unset — dumps leave this host in PLAINTEXT (user emails, balances, encrypted-cred blobs)"
fi

# Offsite: rclone remote `offsite:` (R2). Not configured yet -> WARN every night until it is
# (day-one checklist item). Configured but failing -> CRIT and NO healthchecks ping: the
# backup is incomplete. Dumps are already encrypted here, so rclone crypt is optional.
offsite_ok=1
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^offsite:'; then
  if ! rclone copy "$BACKUP_DIR" "offsite:hedgefun-backups/" \
        --include "*-$STAMP.dump*" \
        --max-duration 15m --quiet 2>/dev/null; then
    offsite_ok=0; notify CRIT "backup: offsite rclone copy FAILED (local dump is fine)"
  fi
elif [ "$(envval "$HEDGEFUN_DIR/.env" BACKUP_OFFSITE_PULL)" = "1" ]; then
  # VPS2 pulls the dumps nightly (ops/vps2/backup-pull.sh) — that IS the offsite copy.
  # Its own dead-man check alerts if the pull stops; rclone/R2 stays a optional second leg.
  :
else
  offsite_ok=0
  notify WARN "backup: no offsite configured (neither rclone 'offsite:' nor BACKUP_OFFSITE_PULL=1) — dumps share the VPS failure domain"
fi

if [ "$fail" -eq 0 ]; then
  BACKUP_HC_URL=$(envval "$HEDGEFUN_DIR/.env" BACKUP_HC_URL)
  if [ "$offsite_ok" -eq 1 ] && [ -n "${BACKUP_HC_URL:-}" ]; then
    # The push URL is itself the credential: leaked, it lets anyone fake a healthy backup
    # and mute the dead-man. Config file on stdin keeps it out of world-readable argv.
    printf 'url = "%s"\n' "$BACKUP_HC_URL" | curl -fsS --max-time 10 -o /dev/null -K - || true
  fi
  echo "[backup] done (offsite_ok=$offsite_ok)"
  exit 0
fi
exit 1
