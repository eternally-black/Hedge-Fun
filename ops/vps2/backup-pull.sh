#!/usr/bin/env bash
# PULL VPS1's verified dumps onto VPS2, nightly at 04:15 (after VPS1's 03:30 dump).
# Paths are RELATIVE on purpose: VPS1 pins this key to `rrsync -ro /opt/hedgefun/backups/`, which
# prepends its own root, so an absolute path here resolves to <root>/<root> and rsync fails with
# `change_dir ... failed`. rrsync rather than a literal `command="rsync --server --sender -logD..."`
# because that string pins the exact flags the client sends and any change to them breaks the pull.
# Pull (not push) on purpose: VPS2 holds a read-only key to VPS1, so a compromised VPS1
# cannot reach — let alone delete — the offsite copies. --ignore-existing makes the copy
# append-only from VPS1's perspective; retention is decided here, by VPS2 alone.
set -uo pipefail

OPS_DIR="${OPS_DIR:-/opt/ops}"
ENV_FILE="$OPS_DIR/.env"
NOTIFY="$OPS_DIR/ops/notify.sh"
DEST="${DEST:-/opt/backups/hedgefun}"
KEY="${KEY:-/root/.ssh/backup_pull}"

envval() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(grep -E "^${1}=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '' | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  fi
  printf '%s' "$v"
}
notify() { bash "$NOTIFY" "$1" "$2" || true; }
# The push URL is a bearer secret — whoever holds it can fake "offsite backup ran" while it
# is dead. Feed it to curl on stdin; argv is world-readable via /proc/<pid>/cmdline.
hc_ping() { [ -n "${1:-}" ] || return 0; printf 'url = "%s"\n' "$1" | curl -fsS --max-time 10 -o /dev/null -K - || true; }

VPS1="$(envval BACKUP_PULL_SOURCE)"   # e.g. root@84.247.169.158 — set in /opt/ops/.env
PORT="$(envval BACKUP_PULL_PORT)"; PORT="${PORT:-22}"
HC_URL="$(envval BACKUP_PULL_HC_URL)"

if [ -z "$VPS1" ]; then
  notify WARN "backup-pull: BACKUP_PULL_SOURCE not set in $ENV_FILE — offsite copies are NOT being made"
  exit 1
fi

mkdir -p "$DEST"; chmod 700 "$DEST"

SSH_CMD="ssh -i $KEY -p $PORT -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

# --exclude '*.tmp': backup.sh stages the RAW pg_dump to <name>.tmp in this very directory and only
# encrypts afterwards, so a dump still running at pull time (or orphaned by a mid-dump reboot — the
# watchdog restarts containers) would ship user emails, balances and bet history to VPS2 in
# CLEARTEXT. --ignore-existing would then pin that copy here for the full retention window, on the
# host the passphrase is deliberately kept off.
# Both staging names: backup.sh writes the raw dump to <name>.tmp and its encrypted twin to
# <name>.tmp.enc, so '*.tmp' alone still shipped a partial, unverified, sidecar-less artifact that
# then looks exactly like a real encrypted dump during an incident.
if ! rsync -az --ignore-existing --exclude='*.tmp' --exclude='*.tmp.enc' --timeout=600 -e "$SSH_CMD" \
      "$VPS1:./" "$DEST/"; then
  notify CRIT "backup-pull: rsync from VPS1 FAILED — offsite backup did not run"
  exit 1
fi

# Verify checksums of anything that has one (VPS1 writes <dump>.sha256 beside each dump).
bad=0
for sums in "$DEST"/*.sha256; do
  [ -f "$sums" ] || continue
  f="${sums%.sha256}"
  [ -f "$f" ] || continue
  if [ "$(sha256sum "$f" | awk '{print $1}')" != "$(cat "$sums")" ]; then
    # Alerting alone would rot: --ignore-existing means every later run SKIPS this file
    # because it exists, so a corrupt copy would stay corrupt until a human intervened.
    # Move both halves aside (quarantine, not delete — VPS1 may already have aged this dump
    # out, and it may have been the .sha256 that rotted) and re-pull them once without
    # --ignore-existing, which is the whole point. A still-absent file also un-blocks the
    # next nightly run, so this self-heals even if the re-fetch itself fails.
    mv -f "$f" "$f.corrupt"; mv -f "$sums" "$sums.corrupt"
    rsync -az --timeout=600 -e "$SSH_CMD" \
      --include="$(basename "$f")" --include="$(basename "$sums")" --exclude='*' \
      "$VPS1:./" "$DEST/" || true
    if [ -f "$f" ] && [ -f "$sums" ] && [ "$(sha256sum "$f" | awk '{print $1}')" = "$(cat "$sums")" ]; then
      rm -f "$f.corrupt" "$sums.corrupt"
      notify WARN "backup-pull: $(basename "$f") was corrupt offsite — re-fetched, now verifies"
    else
      bad=1; notify CRIT "backup-pull: checksum MISMATCH on $(basename "$f") — re-fetch did NOT repair it; bad copy kept as *.corrupt"
    fi
  fi
done

# Retention on VPS2: keep everything 28 days (VPS1 already thins to 7d/4w; this side just
# bounds the disk). Date parsed from the filename, not mtime.
for f in "$DEST"/*.dump*; do
  [ -f "$f" ] || continue
  # Quarantined pairs end .corrupt, so a bare *.sha256 test misses <name>.sha256.corrupt while
  # *.dump* still matches it — the loop then aged out half a pair on its own.
  case "$f" in *.sha256 | *.sha256.corrupt) continue ;; esac # dropped together with its dump below
  d=$(basename "$f" | grep -oE '[0-9]{8}' | head -1); [ -n "$d" ] || continue
  age_days=$(( ( $(date -u +%s) - $(date -u -d "$d" +%s 2>/dev/null || echo 0) ) / 86400 ))
  if [ "$age_days" -gt 28 ]; then rm -f "$f" "$f.sha256"; fi
done

if [ "$bad" -eq 0 ]; then
  if [ -n "$HC_URL" ]; then hc_ping "$HC_URL"; fi
  echo "[backup-pull] ok ($(ls "$DEST" | wc -l) files)"
  exit 0
fi
exit 1
