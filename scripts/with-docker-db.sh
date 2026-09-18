#!/usr/bin/env bash
# Run one command against a disposable, isolated Postgres.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/with-docker-db.sh <command...>" >&2
  exit 64
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT/docker-compose.test.yml"

find_docker() {
  if [ -n "${HF_DOCKER_BIN:-}" ]; then printf '%s\n' "$HF_DOCKER_BIN"; return; fi
  if command -v docker >/dev/null 2>&1; then command -v docker; return; fi
  local win="/c/Program Files/Docker/Docker/resources/bin/docker.exe"
  [ -x "$win" ] && { printf '%s\n' "$win"; return; }
  return 1
}

DOCKER=$(find_docker) || { echo "Docker CLI not found" >&2; exit 1; }

# A unique project name is the cleanup boundary. Keep the format deliberately strict so
# a future edit cannot turn `compose down` into an operation on dev or production.
rand=$(od -An -N6 -tx1 /dev/urandom 2>/dev/null | tr -d ' \r\n')
[ -n "$rand" ] || rand="$$-$(date +%s)"
PROJECT="hf-testdb-$$-$rand"
case "$PROJECT" in hf-testdb-[0-9]*-[a-f0-9-]*) ;; *) echo "unsafe Compose project: $PROJECT" >&2; exit 1 ;; esac

project_owned() {
  local kind id label
  for kind in container network volume; do
    case "$kind" in
      container) list=(ps -aq --filter "label=com.docker.compose.project=$PROJECT") ;;
      network) list=(network ls -q --filter "label=com.docker.compose.project=$PROJECT") ;;
      volume) list=(volume ls -q --filter "label=com.docker.compose.project=$PROJECT") ;;
    esac
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      if [ "$kind" = container ]; then
        label=$("$DOCKER" inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id" 2>/dev/null || true)
      else
        label=$("$DOCKER" "$kind" inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$id" 2>/dev/null || true)
      fi
      [ "$label" = "$PROJECT" ] || return 1
    done < <("$DOCKER" "${list[@]}" 2>/dev/null || true)
  done
}

touched=0
cleanup() {
  local code=$? cleanup_code=0
  trap - EXIT INT TERM
  if [ "$touched" -eq 1 ]; then
    if project_owned; then
      if ! "$DOCKER" compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1; then
        echo "cleanup failed for isolated Compose project $PROJECT" >&2
        cleanup_code=1
      fi
    else
      echo "refusing cleanup: resources do not all belong to $PROJECT" >&2
      cleanup_code=1
    fi
  fi
  # Preserve the command/start failure. A cleanup failure becomes the status only when the
  # requested command itself succeeded.
  [ "$code" -ne 0 ] && exit "$code"
  exit "$cleanup_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! "$DOCKER" info >/dev/null 2>&1; then
  # Docker Desktop can be started headlessly on Windows. We deliberately leave the global
  # engine running: other work may begin using it while this test is active.
  if "$DOCKER" desktop start >/dev/null 2>&1; then
    for _ in $(seq 1 60); do
      "$DOCKER" info >/dev/null 2>&1 && break
      sleep 2
    done
  fi
fi
"$DOCKER" info >/dev/null 2>&1 || { echo "Docker engine is unavailable" >&2; exit 1; }

echo "[test-db] starting isolated project $PROJECT"
touched=1
if "$DOCKER" compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --wait db; then
  :
else
  start_code=$?
  echo "failed to start isolated test database project $PROJECT" >&2
  exit "$start_code"
fi

binding=$("$DOCKER" compose -p "$PROJECT" -f "$COMPOSE_FILE" port db 5432)
port=${binding##*:}
case "$port" in ''|*[!0-9]*) echo "invalid Docker-assigned database port: $binding" >&2; exit 1 ;; esac

# Always replace a caller-provided URL. Test code can only reach this run's loopback database.
export DATABASE_URL="postgresql://hedgefun_test:hedgefun_test@127.0.0.1:${port}/hedgefun_test"
echo "[test-db] database ready on 127.0.0.1:$port"

set +e
"$@"
code=$?
set -e
exit "$code"
