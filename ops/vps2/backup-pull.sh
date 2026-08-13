#!/usr/bin/env bash
# PULL VPS1's verified dumps onto VPS2, nightly at 04:15 (after VPS1's 03:30 dump).
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
    v="$(grep -E "^${1}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  fi
  printf '%s' "$v"
}
notify() { bash "$NOTIFY" "$1" "$2" || true; }

VPS1="$(envval BACKUP_PULL_SOURCE)"   # e.g. root@84.247.169.158 — set in /opt/ops/.env
PORT="$(envval BACKUP_PULL_PORT)"; PORT="${PORT:-22}"
HC_URL="$(envval BACKUP_PULL_HC_URL)"

if [ -z "$VPS1" ]; then
  notify WARN "backup-pull: BACKUP_PULL_SOURCE not set in $ENV_FILE — offsite copies are NOT being made"
  exit 1
fi

mkdir -p "$DEST"; chmod 700 "$DEST"

if ! rsync -az --ignore-existing --timeout=600 \
      -e "ssh -i $KEY -p $PORT -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \
      "$VPS1:/opt/hedgefun/backups/" "$DEST/"; then
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
    bad=1; notify CRIT "backup-pull: checksum MISMATCH on $(basename "$f")"
  fi
done

# Retention on VPS2: keep everything 28 days (VPS1 already thins to 7d/4w; this side just
# bounds the disk). Date parsed from the filename, not mtime.
for f in "$DEST"/*.dump; do
  [ -f "$f" ] || continue
  d=$(basename "$f" | grep -oE '[0-9]{8}' | head -1); [ -n "$d" ] || continue
  age_days=$(( ( $(date -u +%s) - $(date -u -d "$d" +%s 2>/dev/null || echo 0) ) / 86400 ))
  if [ "$age_days" -gt 28 ]; then rm -f "$f" "$f.sha256"; fi
done

if [ "$bad" -eq 0 ]; then
  if [ -n "$HC_URL" ]; then curl -fsS --max-time 10 -o /dev/null "$HC_URL" || true; fi
  echo "[backup-pull] ok ($(ls "$DEST" | wc -l) files)"
  exit 0
fi
exit 1
