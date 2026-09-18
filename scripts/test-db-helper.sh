#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/hf-db-helper-test.XXXXXX")
case "$TMP" in /tmp/*|/var/tmp/*) ;; *) echo "unsafe temp path: $TMP" >&2; exit 1 ;; esac
trap 'rm -rf "$TMP"' EXIT

LOG="$TMP/docker.log"
STATE="$TMP/project"
cat > "$TMP/docker" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "${1:-}" = info ]; then exit 0; fi
if [ "${1:-}" = compose ]; then
  project=
  prev=
  for arg in "$@"; do
    [ "$prev" = -p ] && project="$arg"
    prev="$arg"
  done
  case " $* " in
    *" up "*) printf '%s' "$project" > "$FAKE_DOCKER_STATE"; [ "${FAKE_UP_FAIL:-0}" = 1 ] && exit 31 ;;
    *" down "*) [ "${FAKE_DOWN_FAIL:-0}" = 1 ] && exit 41 ;;
    *" port db 5432 "*) echo '127.0.0.1:49173' ;;
  esac
  exit 0
fi
if [ "${1:-}" = ps ]; then echo fake-db-container; exit 0; fi
if [ "${1:-}" = inspect ]; then cat "$FAKE_DOCKER_STATE"; exit 0; fi
exit 1
FAKE
chmod +x "$TMP/docker"

cat > "$TMP/child" <<'CHILD'
#!/usr/bin/env bash
printf '%s' "$DATABASE_URL" > "$CHILD_URL_FILE"
printf ran > "$CHILD_RAN_FILE"
exit "${CHILD_EXIT:-23}"
CHILD
chmod +x "$TMP/child"

set +e
DATABASE_URL='postgresql://attacker@remote.example/prod' \
HF_DOCKER_BIN="$TMP/docker" FAKE_DOCKER_LOG="$LOG" FAKE_DOCKER_STATE="$STATE" \
CHILD_URL_FILE="$TMP/url" CHILD_RAN_FILE="$TMP/ran" bash "$ROOT/scripts/with-docker-db.sh" "$TMP/child"
code=$?
set -e

[ "$code" -eq 23 ] || { echo "child exit code was not preserved: $code" >&2; exit 1; }
grep -Eq '^postgresql://hedgefun_test:hedgefun_test@127\.0\.0\.1:49173/hedgefun_test$' "$TMP/url"
grep -Eq 'compose -p hf-testdb-[0-9]+-[a-f0-9]+ .*docker-compose\.test\.yml up -d --wait db' "$LOG"
grep -Eq 'compose -p hf-testdb-[0-9]+-[a-f0-9]+ .*docker-compose\.test\.yml down -v --remove-orphans' "$LOG"
! grep -q 'docker-compose.dev.yml' "$LOG"
! grep -q 'desktop stop' "$LOG"

up_project=$(sed -n 's/.*compose -p \([^ ]*\).* up -d --wait db.*/\1/p' "$LOG")
down_project=$(sed -n 's/.*compose -p \([^ ]*\).* down -v.*/\1/p' "$LOG")
[ "$up_project" = "$down_project" ]

# A failed Compose start stops immediately, preserves that status, and still cleans its unique
# partially-created project. The requested child must never run.
: > "$LOG"; rm -f "$TMP/ran" "$TMP/url"
set +e
HF_DOCKER_BIN="$TMP/docker" FAKE_DOCKER_LOG="$LOG" FAKE_DOCKER_STATE="$STATE" FAKE_UP_FAIL=1 \
CHILD_URL_FILE="$TMP/url" CHILD_RAN_FILE="$TMP/ran" \
bash "$ROOT/scripts/with-docker-db.sh" "$TMP/child" >"$TMP/up-fail.out" 2>"$TMP/up-fail.err"
up_fail_code=$?
set -e
[ "$up_fail_code" -eq 31 ]
[ ! -e "$TMP/ran" ]
grep -q 'failed to start isolated test database project' "$TMP/up-fail.err"
grep -q ' down -v --remove-orphans' "$LOG"

# Cleanup failure is visible but cannot replace the requested command's failure status.
: > "$LOG"; rm -f "$TMP/ran" "$TMP/url"
set +e
HF_DOCKER_BIN="$TMP/docker" FAKE_DOCKER_LOG="$LOG" FAKE_DOCKER_STATE="$STATE" FAKE_DOWN_FAIL=1 \
CHILD_URL_FILE="$TMP/url" CHILD_RAN_FILE="$TMP/ran" CHILD_EXIT=23 \
bash "$ROOT/scripts/with-docker-db.sh" "$TMP/child" >"$TMP/down-fail.out" 2>"$TMP/down-fail.err"
down_fail_code=$?
set -e
[ "$down_fail_code" -eq 23 ]
grep -q 'cleanup failed for isolated Compose project' "$TMP/down-fail.err"

# When the requested command succeeds, cleanup failure becomes the helper failure.
: > "$LOG"; rm -f "$TMP/ran" "$TMP/url"
set +e
HF_DOCKER_BIN="$TMP/docker" FAKE_DOCKER_LOG="$LOG" FAKE_DOCKER_STATE="$STATE" FAKE_DOWN_FAIL=1 \
CHILD_URL_FILE="$TMP/url" CHILD_RAN_FILE="$TMP/ran" CHILD_EXIT=0 \
bash "$ROOT/scripts/with-docker-db.sh" "$TMP/child" >"$TMP/cleanup-only.out" 2>"$TMP/cleanup-only.err"
cleanup_only_code=$?
set -e
[ "$cleanup_only_code" -eq 1 ]
grep -q 'cleanup failed for isolated Compose project' "$TMP/cleanup-only.err"

# The Node launcher must select Git Bash on Windows and preserve the helper/child status.
: > "$LOG"; rm -f "$TMP/ran" "$TMP/url"
set +e
HF_DOCKER_BIN="$TMP/docker" FAKE_DOCKER_LOG="$LOG" FAKE_DOCKER_STATE="$STATE" \
CHILD_URL_FILE="$TMP/url" CHILD_RAN_FILE="$TMP/ran" CHILD_EXIT=23 \
node "$ROOT/scripts/with-docker-db.cjs" "$TMP/child" >"$TMP/launcher.out" 2>"$TMP/launcher.err"
launcher_code=$?
set -e
[ "$launcher_code" -eq 23 ]
[ -f "$TMP/ran" ]

echo "test-db-helper: PASS"
