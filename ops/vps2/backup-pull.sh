#!/usr/bin/env bash
# Pull VPS1 encrypted backups onto VPS2 and prove a fresh, complete daily pair exists.
set -uo pipefail

OPS_DIR="${OPS_DIR:-/opt/ops}"
ENV_FILE="$OPS_DIR/.env"
NOTIFY="$OPS_DIR/ops/notify.sh"
DEST="${DEST:-/opt/backups/hedgefun}"
KEY="${KEY:-/root/.ssh/backup_pull}"
RSYNC_BIN="${BACKUP_PULL_RSYNC_BIN:-rsync}"
CURL_BIN="${BACKUP_PULL_CURL_BIN:-curl}"

envval() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(grep -E "^${1}=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r\n' | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  fi
  printf '%s' "$v"
}
notify() { bash "$NOTIFY" "$1" "$2" 2>/dev/null || true; }
hc_ping() {
  local url="${1:-}"
  [ -n "$url" ] || return 0
  printf 'url = "%s"\n' "$url" | "$CURL_BIN" -fsS --max-time 10 -o /dev/null -K - >/dev/null 2>&1 || true
}
fail() {
  notify CRIT "backup-pull: $1"
  hc_ping "$HC_FAIL_URL"
  echo "[backup-pull] FAILED: $1" >&2
  exit 1
}

VPS1="$(envval BACKUP_PULL_SOURCE)"
PORT="$(envval BACKUP_PULL_PORT)"; PORT="${PORT:-22}"
HC_URL="$(envval BACKUP_PULL_HC_URL)"
HC_FAIL_URL="$(envval BACKUP_PULL_HC_FAIL_URL)"
if [ -z "$HC_FAIL_URL" ]; then
  case "$HC_URL" in
    *hc-ping.com/*|*healthchecks.io/*) HC_FAIL_URL="${HC_URL%/}/fail" ;;
  esac
fi
MAX_AGE_HOURS="$(envval BACKUP_PULL_MAX_AGE_HOURS)"; MAX_AGE_HOURS="${MAX_AGE_HOURS:-48}"
REQUIRE_GLITCHTIP="$(envval BACKUP_PULL_REQUIRE_GLITCHTIP)"; REQUIRE_GLITCHTIP="${REQUIRE_GLITCHTIP:-0}"
NOW_EPOCH="${BACKUP_PULL_NOW_EPOCH:-$(date -u +%s)}"

[ -n "$VPS1" ] || fail "BACKUP_PULL_SOURCE not set in $ENV_FILE — offsite copies are NOT being made"
case "$PORT" in ''|*[!0-9]*) fail "BACKUP_PULL_PORT is invalid" ;; esac
case "$MAX_AGE_HOURS" in ''|*[!0-9]*) fail "BACKUP_PULL_MAX_AGE_HOURS is invalid" ;; esac
[ "$MAX_AGE_HOURS" -ge 24 ] && [ "$MAX_AGE_HOURS" -le 168 ] || fail "BACKUP_PULL_MAX_AGE_HOURS must be 24..168"
case "$REQUIRE_GLITCHTIP" in 0|1) ;; *) fail "BACKUP_PULL_REQUIRE_GLITCHTIP must be 0 or 1" ;; esac
case "$NOW_EPOCH" in ''|*[!0-9]*) fail "current epoch is invalid" ;; esac

mkdir -p "$DEST" || fail "cannot create destination"
chmod 700 "$DEST" || fail "cannot protect destination"
SSH_CMD="ssh -i $KEY -p $PORT -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

# Raw *.tmp and partially encrypted *.tmp.enc files must never leave VPS1. --ignore-existing
# keeps the source unable to overwrite the append-only offsite history.
if ! "$RSYNC_BIN" -az --ignore-existing --exclude='*.tmp' --exclude='*.tmp.enc' \
     --timeout=600 -e "$SSH_CMD" "$VPS1:./" "$DEST/"; then
  fail "rsync from VPS1 FAILED — offsite backup did not run"
fi

checksum_ok() {
  local data="$1" sums="$data.sha256" expected actual
  [ -s "$data" ] && [ -f "$sums" ] || return 1
  expected=$(tr -d '\r\n' < "$sums")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual=$(sha256sum "$data" | awk '{print $1}')
  [ "$actual" = "$expected" ]
}

# A corrupt local pair would otherwise be skipped forever by --ignore-existing. Quarantine it,
# fetch that exact pair once, and retain *.corrupt evidence if repair does not succeed.
repair_corrupt_pairs() {
  local data sums base bad=0
  while IFS= read -r -d '' data; do
    base=$(basename "$data")
    case "$base" in
      hedgefun-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc|\
      glitchtip-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc|\
      hedgefun-predeploy-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9].dump.enc) ;;
      *) continue ;;
    esac
    sums="$data.sha256"
    [ -f "$sums" ] || continue
    checksum_ok "$data" && continue
    mv -f "$data" "$data.corrupt"
    mv -f "$sums" "$sums.corrupt"
    "$RSYNC_BIN" -az --timeout=600 -e "$SSH_CMD" \
      --include="$base" --include="$base.sha256" --exclude='*' "$VPS1:./" "$DEST/" || true
    if checksum_ok "$data"; then
      rm -f "$data.corrupt" "$sums.corrupt"
      notify WARN "backup-pull: $base was corrupt offsite — re-fetched, now verifies"
    else
      bad=1
      notify CRIT "backup-pull: checksum mismatch on $base — re-fetch did not repair it; evidence kept as *.corrupt"
    fi
  done < <(find "$DEST" -maxdepth 1 -type f -name '*.dump.enc' -print0)
  [ "$bad" -eq 0 ]
}

validate_backups() {
  local path name data date_text date_epoch age max_age_seconds
  local recognized=0 fresh_hf=0 fresh_gt=0
  max_age_seconds=$((MAX_AGE_HOURS * 3600))

  # Sidecars without their encrypted payload are incomplete pairs.
  while IFS= read -r -d '' path; do
    name=$(basename "$path")
    case "$name" in
      hedgefun-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc.sha256|\
      glitchtip-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc.sha256|\
      hedgefun-predeploy-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9].dump.enc.sha256)
        data="${path%.sha256}"
        [ -f "$data" ] || { echo "missing payload for $name" >&2; return 1; }
        ;;
    esac
  done < <(find "$DEST" -maxdepth 1 -type f -name '*.sha256' -print0)

  # Plaintext recognized backups violate the offsite encryption contract.
  while IFS= read -r -d '' path; do
    name=$(basename "$path")
    case "$name" in
      hedgefun-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump|\
      glitchtip-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump|\
      hedgefun-predeploy-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9].dump)
        echo "unencrypted backup present: $name" >&2; return 1 ;;
    esac
  done < <(find "$DEST" -maxdepth 1 -type f -name '*.dump' -print0)

  while IFS= read -r -d '' path; do
    name=$(basename "$path")
    case "$name" in
      hedgefun-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc)
        date_text=${name#hedgefun-}; date_text=${date_text%%.dump.enc}; recognized=$((recognized + 1)); kind=hf ;;
      glitchtip-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc)
        date_text=${name#glitchtip-}; date_text=${date_text%%.dump.enc}; recognized=$((recognized + 1)); kind=gt ;;
      hedgefun-predeploy-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9].dump.enc)
        date_text=${name#hedgefun-predeploy-}; date_text=${date_text%%-*}; recognized=$((recognized + 1)); kind=predeploy ;;
      *) continue ;;
    esac
    checksum_ok "$path" || { echo "incomplete or invalid checksum pair: $name" >&2; return 1; }
    date_epoch=$(date -u -d "$date_text" +%s 2>/dev/null) || { echo "invalid backup date: $name" >&2; return 1; }
    age=$((NOW_EPOCH - date_epoch))
    [ "$age" -ge 0 ] || { echo "future-dated backup: $name" >&2; return 1; }
    if [ "$age" -le "$max_age_seconds" ]; then
      [ "$kind" = hf ] && fresh_hf=$((fresh_hf + 1))
      [ "$kind" = gt ] && fresh_gt=$((fresh_gt + 1))
    fi
  done < <(find "$DEST" -maxdepth 1 -type f -name '*.dump.enc' -print0)

  [ "$recognized" -gt 0 ] || { echo "no recognized encrypted backups" >&2; return 1; }
  [ "$fresh_hf" -gt 0 ] || { echo "no fresh HedgeFun daily encrypted backup within ${MAX_AGE_HOURS}h" >&2; return 1; }
  if [ "$REQUIRE_GLITCHTIP" = 1 ]; then
    [ "$fresh_gt" -gt 0 ] || { echo "GlitchTip backup is required but no fresh daily pair exists" >&2; return 1; }
  fi
}

repair_corrupt_pairs || fail "one or more corrupt backup pairs could not be repaired"
validation_error=$(validate_backups 2>&1) || fail "$validation_error"

# Retention runs only after a valid fresh daily pair is proven. It only removes recognized
# artifacts, using the filename date so rsync metadata cannot make an old backup look fresh.
while IFS= read -r -d '' data; do
  name=$(basename "$data")
  case "$name" in
    hedgefun-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc|\
    glitchtip-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].dump.enc)
      date_text=${name#*-}; date_text=${date_text%%.dump.enc} ;;
    hedgefun-predeploy-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9].dump.enc)
      date_text=${name#hedgefun-predeploy-}; date_text=${date_text%%-*} ;;
    *) continue ;;
  esac
  date_epoch=$(date -u -d "$date_text" +%s 2>/dev/null || echo 0)
  age_days=$(( (NOW_EPOCH - date_epoch) / 86400 ))
  if [ "$age_days" -gt 28 ]; then rm -f "$data" "$data.sha256"; fi
done < <(find "$DEST" -maxdepth 1 -type f -name '*.dump.enc' -print0)

# Prove retention did not remove the only qualifying pair before reporting success.
validation_error=$(validate_backups 2>&1) || fail "post-retention validation failed: $validation_error"
hc_ping "$HC_URL"
echo "[backup-pull] ok — fresh verified encrypted HedgeFun daily backup present"
