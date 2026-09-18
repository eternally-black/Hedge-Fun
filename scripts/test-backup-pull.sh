#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/ops/vps2/backup-pull.sh"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/hf-backup-pull-test.XXXXXX")
case "$BASE" in /tmp/*|/var/tmp/*) ;; *) echo "unsafe temp path: $BASE" >&2; exit 1 ;; esac
trap 'rm -rf "$BASE"' EXIT
NOW=$(date -u -d '2026-09-19 05:00:00' +%s)

cat > "$BASE/rsync" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_LOG"
[ "${FAKE_RSYNC_FAIL:-0}" = 1 ] && exit 12
dest=${!#}; dest=${dest%/}
mkdir -p "$dest"
if [[ " $* " == *" --ignore-existing "* ]]; then
  for f in "$FAKE_SOURCE"/*; do [ -f "$f" ] || continue; [ -e "$dest/$(basename "$f")" ] || cp "$f" "$dest/"; done
else
  for f in "$FAKE_SOURCE"/*; do [ -f "$f" ] || continue; cp -f "$f" "$dest/"; done
fi
FAKE
chmod +x "$BASE/rsync"

cat > "$BASE/curl" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf 'args:%s\n' "$*" >> "$FAKE_CURL_LOG"
cat >> "$FAKE_CURL_LOG"
FAKE
chmod +x "$BASE/curl"

make_pair() {
  local dir="$1" name="$2" body="${3:-backup-data-$name}"
  printf '%s' "$body" > "$dir/$name"
  sha256sum "$dir/$name" | awk '{print $1}' > "$dir/$name.sha256"
}

run_case() {
  local name="$1" expected="$2" case_dir src dest ops
  case_dir="$BASE/$name"; src="$case_dir/src"; dest="$case_dir/dest"; ops="$case_dir/ops"
  mkdir -p "$src" "$dest" "$ops/ops"
  cat > "$ops/ops/notify.sh" <<'NOTIFY'
#!/usr/bin/env bash
printf '%s:%s\n' "$1" "$2" >> "$FAKE_NOTIFY_LOG"
NOTIFY
  chmod +x "$ops/ops/notify.sh"
  : > "$case_dir/rsync.log"; : > "$case_dir/curl.log"; : > "$case_dir/notify.log"
  if declare -F "setup_$name" >/dev/null; then "setup_$name" "$src" "$dest"; fi
  set +e
  OPS_DIR="$ops" DEST="$dest" BACKUP_PULL_SOURCE=fake@vps1 BACKUP_PULL_PORT=22 \
  BACKUP_PULL_HC_URL='https://hc.example/secret-token' BACKUP_PULL_NOW_EPOCH="$NOW" \
  BACKUP_PULL_HC_FAIL_URL='https://hc.example/secret-token/fail' \
  BACKUP_PULL_REQUIRE_GLITCHTIP="${CASE_REQUIRE_GT:-0}" \
  BACKUP_PULL_RSYNC_BIN="$BASE/rsync" BACKUP_PULL_CURL_BIN="$BASE/curl" \
  FAKE_SOURCE="$src" FAKE_LOG="$case_dir/rsync.log" FAKE_CURL_LOG="$case_dir/curl.log" \
  FAKE_NOTIFY_LOG="$case_dir/notify.log" FAKE_RSYNC_FAIL="${CASE_RSYNC_FAIL:-0}" \
  bash "$SCRIPT" >"$case_dir/out" 2>"$case_dir/err"
  code=$?
  set -e
  CASE_RSYNC_FAIL=0
  CASE_REQUIRE_GT=0
  if [ "$expected" = pass ]; then
    [ "$code" -eq 0 ] || { echo "$name unexpectedly failed" >&2; cat "$case_dir/err" >&2; exit 1; }
    ! grep -q 'secret-token' <(sed -n '/^args:/p' "$case_dir/curl.log")
  else
    [ "$code" -ne 0 ] || { echo "$name unexpectedly passed" >&2; exit 1; }
    grep -q '/fail' "$case_dir/curl.log"
  fi
}

setup_empty() { :; }
setup_stale() { make_pair "$1" hedgefun-20260916.dump.enc; }
setup_half() { printf data > "$1/hedgefun-20260919.dump.enc"; }
setup_invalidhash() { printf data > "$1/hedgefun-20260919.dump.enc"; printf '%064d\n' 0 > "$1/hedgefun-20260919.dump.enc.sha256"; }
setup_repaired() {
  make_pair "$1" hedgefun-20260919.dump.enc good
  printf corrupt > "$2/hedgefun-20260919.dump.enc"
  cp "$1/hedgefun-20260919.dump.enc.sha256" "$2/"
}
setup_rsyncfail() { make_pair "$1" hedgefun-20260919.dump.enc; CASE_RSYNC_FAIL=1; }
setup_fresh() { make_pair "$1" hedgefun-20260919.dump.enc; }
setup_retention() { make_pair "$1" hedgefun-20260919.dump.enc; make_pair "$1" hedgefun-20260801.dump.enc; }
setup_predeployonly() { make_pair "$1" hedgefun-predeploy-20260919-0400.dump.enc; }
setup_future() { make_pair "$1" hedgefun-20260920.dump.enc; }
setup_mixedbad() { make_pair "$1" hedgefun-20260919.dump.enc; printf bad > "$1/hedgefun-20260918.dump.enc"; printf '%064d\n' 0 > "$1/hedgefun-20260918.dump.enc.sha256"; }
setup_requiredgt() { make_pair "$1" hedgefun-20260919.dump.enc; CASE_REQUIRE_GT=1; }
setup_requiredgtpass() { make_pair "$1" hedgefun-20260919.dump.enc; make_pair "$1" glitchtip-20260919.dump.enc; CASE_REQUIRE_GT=1; }

run_case empty fail
run_case stale fail
run_case half fail
run_case invalidhash fail
run_case repaired pass
grep -q 're-fetched, now verifies' "$BASE/repaired/notify.log"
run_case rsyncfail fail
run_case fresh pass
run_case retention pass
[ ! -e "$BASE/retention/dest/hedgefun-20260801.dump.enc" ]
run_case predeployonly fail
run_case future fail
run_case mixedbad fail
run_case requiredgt fail
run_case requiredgtpass pass

echo "test-backup-pull: PASS"
