#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$REPO/deploy.sh"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/hf-deploy-test.XXXXXX")
case "$BASE" in /tmp/*|/var/tmp/*) ;; *) echo "unsafe temp path: $BASE" >&2; exit 1 ;; esac
trap 'rm -rf "$BASE"' EXIT

PREV=1111111111111111111111111111111111111111
TARGET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
NEW_PUSH=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PREV_DIGEST=$(printf '1%.0s' {1..64})
TARGET_DIGEST=$(printf 'a%.0s' {1..64})
PREV_REF="ghcr.io/eternally-black/hedge-fun@sha256:$PREV_DIGEST"
TARGET_REF="ghcr.io/eternally-black/hedge-fun@sha256:$TARGET_DIGEST"
PREV_ID="sha256:$PREV_DIGEST"
TARGET_ID="sha256:$TARGET_DIGEST"

cat > "$BASE/git" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf 'git %s\n' "$*" >> "$FAKE_LOG"
case "${1:-}" in
  cat-file) [[ "${3:-}" == *:docker-compose.override.yml ]] && exit 1; exit 0 ;;
  fetch) exit 0 ;;
  rev-parse)
    if [ "${2:-}" = HEAD ]; then cat "$FAKE_SHA_FILE"
    else value=${2%\^\{commit\}}; printf '%s\n' "$value"
    fi
    ;;
  reset)
    target=${3:-}
    printf '%s' "$target" > "$FAKE_SHA_FILE"
    printf 'config-%s\n' "$target" > "$FAKE_ROOT/Caddyfile"
    ;;
  *) echo "unexpected fake git command: $*" >&2; exit 2 ;;
esac
FAKE
chmod +x "$BASE/git"

cat > "$BASE/docker" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf 'docker %s\n' "$*" >> "$FAKE_LOG"
if [ "${1:-}" = login ]; then cat >/dev/null; exit 0; fi
if [ "${1:-}" = pull ]; then [ "$2" = "$FAKE_TARGET_REF" ]; exit $?; fi
if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
  format=${4:-}; ref=${5:-}
  if [[ "$format" == *org.opencontainers.image.revision* ]]; then
    printf '%s\n' "${FAKE_LABEL_SHA:-$FAKE_TARGET_SHA}"
  elif [[ "$format" == *'.Id'* ]]; then
    [ "$ref" = "$FAKE_TARGET_REF" ] && printf '%s\n' "$FAKE_TARGET_ID" || printf '%s\n' "$FAKE_PREV_ID"
  fi
  exit 0
fi
if [ "${1:-}" = image ] && [ "${2:-}" = prune ]; then exit 0; fi
if [ "${1:-}" = inspect ]; then cat "$FAKE_IMAGE_FILE"; exit 0; fi
if [ "${1:-}" = compose ]; then
  args=" $* "
  if [[ "$args" == *" ps -q app "* ]]; then echo cid-app; exit 0; fi
  if [[ "$args" == *" ps -q poller "* ]]; then echo cid-poller; exit 0; fi
  if [[ "$args" == *" up "* ]]; then
    if [[ "$args" == *" --remove-orphans "* ]] && [ -f "$FAKE_FAIL_ONCE" ] && [ "$(cat "$FAKE_SHA_FILE")" = "$FAKE_TARGET_SHA" ]; then
      rm -f "$FAKE_FAIL_ONCE"
      exit 17
    fi
    if [[ "$args" == *" --remove-orphans "* ]] && [ "${FAKE_RECOVERY_FAIL:-0}" = 1 ] && [ "$(cat "$FAKE_SHA_FILE")" != "$FAKE_TARGET_SHA" ]; then
      exit 19
    fi
    if [[ "$args" == *" --remove-orphans "* ]]; then
      ref=$(sed -n 's/^[[:space:]]*image: "\([^"]*\)"/\1/p' "$FAKE_OVERRIDE" | head -1)
      if [ "$ref" = "$FAKE_TARGET_REF" ]; then printf '%s' "$FAKE_TARGET_ID" > "$FAKE_IMAGE_FILE"
      elif [ "$ref" = "$FAKE_PREV_REF" ]; then printf '%s' "$FAKE_PREV_ID" > "$FAKE_IMAGE_FILE"
      elif [[ "$ref" == sha256:* ]]; then printf '%s' "$ref" > "$FAKE_IMAGE_FILE"
      else echo "unrecognized override ref: $ref" >&2; exit 3
      fi
    fi
    exit 0
  fi
  exit 0
fi
echo "unexpected fake docker command: $*" >&2
exit 2
FAKE
chmod +x "$BASE/docker"

cat > "$BASE/mv" <<'FAKE'
#!/usr/bin/env bash
set -eu
dest=${!#}
if [ -f "${FAKE_MARKER_FAIL_ONCE:-/nonexistent}" ] && [ "$(basename "$dest")" = .deployed_release ]; then
  rm -f "$FAKE_MARKER_FAIL_ONCE"
  exit 29
fi
exec /usr/bin/mv "$@"
FAKE
chmod +x "$BASE/mv"

setup_root() {
  local name="$1" root
  root="$BASE/$name/root"
  mkdir -p "$root/ops" "$BASE/$name/state"
  printf 'GHCR_USER=test\nGHCR_TOKEN=test\n' > "$root/.env"
  printf 'config-%s\n' "$PREV" > "$root/Caddyfile"
  cat > "$root/ops/notify.sh" <<'NOTIFY'
#!/usr/bin/env bash
printf '%s:%s\n' "$1" "$2" >> "$FAKE_NOTIFY_LOG"
NOTIFY
  chmod +x "$root/ops/notify.sh"
  printf '%s' "$PREV" > "$BASE/$name/sha"
  printf '%s' "$PREV_ID" > "$BASE/$name/image"
  printf 'GIT_SHA=%s\nIMAGE_REF=%s\n' "$PREV" "$PREV_REF" > "$root/.deployed_release"
  printf '%s\n' "$PREV" > "$root/.deployed_sha"
  printf 'services:\n  app:\n    image: "%s"\n  migrate:\n    image: "%s"\n  poller:\n    image: "%s"\n' \
    "$PREV_REF" "$PREV_REF" "$PREV_REF" > "$root/docker-compose.override.yml"
  : > "$BASE/$name/log"
  : > "$BASE/$name/notify.log"
  printf '%s' "$root"
}

run_deploy() {
  local name="$1" root="$2"
  PATH="$BASE:$PATH" HF_DEPLOY_ROOT="$root" HF_STATE_DIR="$BASE/$name/state" \
  HF_SKIP_HOST_OPS=1 HF_SKIP_BACKUP=1 FAKE_ROOT="$root" FAKE_LOG="$BASE/$name/log" \
  FAKE_NOTIFY_LOG="$BASE/$name/notify.log" \
  FAKE_SHA_FILE="$BASE/$name/sha" FAKE_IMAGE_FILE="$BASE/$name/image" \
  FAKE_OVERRIDE="$root/docker-compose.override.yml" FAKE_TARGET_SHA="$TARGET" \
  FAKE_TARGET_REF="$TARGET_REF" FAKE_TARGET_ID="$TARGET_ID" FAKE_PREV_REF="$PREV_REF" \
  FAKE_PREV_ID="$PREV_ID" FAKE_FAIL_ONCE="$BASE/$name/fail-once" \
  FAKE_MARKER_FAIL_ONCE="$BASE/$name/marker-fail-once" \
  FAKE_RECOVERY_FAIL="${FAKE_RECOVERY_FAIL_OVERRIDE:-0}" \
  FAKE_LABEL_SHA="${FAKE_LABEL_SHA_OVERRIDE:-$TARGET}" \
  bash "$SCRIPT" deploy "$TARGET" "$TARGET_REF"
}

success_root=$(setup_root success)
run_deploy success "$success_root" >/dev/null
[ "$(cat "$BASE/success/sha")" = "$TARGET" ]
[ "$(cat "$BASE/success/image")" = "$TARGET_ID" ]
grep -q "^GIT_SHA=$TARGET$" "$success_root/.deployed_release"
grep -q "^IMAGE_REF=$TARGET_REF$" "$success_root/.deployed_release"
grep -q "image: \"$TARGET_REF\"" "$success_root/docker-compose.override.yml"
! grep -q 'origin/main\|:latest' "$BASE/success/log"
! grep -q "$NEW_PUSH" "$BASE/success/log"
stop_line=$(grep -n 'docker compose stop app poller' "$BASE/success/log" | cut -d: -f1)
migrate_line=$(grep -n 'docker compose run --rm migrate' "$BASE/success/log" | head -1 | cut -d: -f1)
[ "$stop_line" -lt "$migrate_line" ]

failure_root=$(setup_root failure)
# Simulate a stale/mis-edited runtime override. Recovery must derive the pin from the last
# confirmed release record, not copy this inconsistent file.
sed -i "s|$PREV_REF|$TARGET_REF|g" "$failure_root/docker-compose.override.yml"
touch "$BASE/failure/fail-once"
set +e
run_deploy failure "$failure_root" >"$BASE/failure/out" 2>"$BASE/failure/err"
failure_code=$?
set -e
[ "$failure_code" -eq 17 ]
[ "$(cat "$BASE/failure/sha")" = "$PREV" ]
[ "$(cat "$BASE/failure/image")" = "$PREV_ID" ]
grep -q "image: \"$PREV_REF\"" "$failure_root/docker-compose.override.yml"
grep -q "^GIT_SHA=$PREV$" "$failure_root/.deployed_release"
grep -q "git reset --hard $TARGET" "$BASE/failure/log"
grep -q "git reset --hard $PREV" "$BASE/failure/log"
grep -q 'previous release restored' "$BASE/failure/notify.log" || {
  echo "expected successful recovery notification" >&2
  cat "$BASE/failure/notify.log" >&2
  cat "$BASE/failure/log" >&2
  cat "$BASE/failure/err" >&2
  exit 1
}

# A failed recovery gate must never fall through to the "restored" notification.
recovery_failure_root=$(setup_root recovery_failure)
touch "$BASE/recovery_failure/fail-once"
FAKE_RECOVERY_FAIL_OVERRIDE=1
set +e
run_deploy recovery_failure "$recovery_failure_root" >/dev/null 2>&1
recovery_failure_code=$?
set -e
unset FAKE_RECOVERY_FAIL_OVERRIDE
[ "$recovery_failure_code" -eq 17 ]
grep -q 'automatic recovery also failed' "$BASE/recovery_failure/notify.log"
! grep -q 'previous release restored' "$BASE/recovery_failure/notify.log"

# If the authoritative marker rename fails after the compatibility SHA moved, recovery restores
# both previous marker files along with the previous config and image.
marker_failure_root=$(setup_root marker_failure)
touch "$BASE/marker_failure/marker-fail-once"
set +e
run_deploy marker_failure "$marker_failure_root" >/dev/null 2>&1
marker_failure_code=$?
set -e
[ "$marker_failure_code" -eq 29 ]
[ "$(cat "$BASE/marker_failure/sha")" = "$PREV" ]
[ "$(cat "$BASE/marker_failure/image")" = "$PREV_ID" ]
grep -q "^GIT_SHA=$PREV$" "$marker_failure_root/.deployed_release"
grep -q "^IMAGE_REF=$PREV_REF$" "$marker_failure_root/.deployed_release"
[ "$(cat "$marker_failure_root/.deployed_sha")" = "$PREV" ]
grep -q 'previous release restored' "$BASE/marker_failure/notify.log"

mismatch_root=$(setup_root mismatch)
FAKE_LABEL_SHA_OVERRIDE="$NEW_PUSH"
set +e
run_deploy mismatch "$mismatch_root" >/dev/null 2>&1
mismatch_code=$?
set -e
unset FAKE_LABEL_SHA_OVERRIDE
[ "$mismatch_code" -ne 0 ]
! grep -q "git reset --hard $TARGET" "$BASE/mismatch/log"

# Workflow contract: build digest + full revision are the only deploy inputs, and the exact
# commit's script is materialized before execution.
grep -q 'digest:.*steps.build.outputs.digest' "$REPO/.github/workflows/deploy.yml"
grep -q 'org.opencontainers.image.revision=.*github.sha' "$REPO/.github/workflows/deploy.yml"
grep -q 'DEPLOY_IMAGE_REF: ghcr.io/eternally-black/hedge-fun@' "$REPO/.github/workflows/deploy.yml"
grep -q 'git show.*DEPLOY_GIT_SHA:deploy.sh' "$REPO/.github/workflows/deploy.yml"
! grep -q 'git reset --hard origin/main' "$REPO/.github/workflows/deploy.yml"

echo "test-deploy-audit: PASS"
