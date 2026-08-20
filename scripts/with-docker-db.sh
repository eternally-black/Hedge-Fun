#!/usr/bin/env bash
# Run a command against the dev Postgres, then power Docker fully OFF — no background daemon, no GUI.
# Usage: bash scripts/with-docker-db.sh <command...>
#   e.g. bash scripts/with-docker-db.sh npm run test:db:run
#
# Lifecycle: `docker desktop start` (headless — needs OpenUIOnStartupDisabled=true in Docker
# Desktop settings, i.e. the "Open Docker Dashboard at startup" box UNCHECKED, so no window pops)
# -> wait for the engine -> db:up (waits healthy) -> <command> -> ALWAYS (even on failure/Ctrl-C)
# db:down + `docker desktop stop` (clean shutdown, no watchdog restart). The engine + container
# only live for the duration of <command>.
set -uo pipefail

DOCKER="/c/Program Files/Docker/Docker/resources/bin/docker.exe"
COMPOSE="docker-compose.dev.yml"

# Did WE start the engine? If it was already up (someone's actively using it), leave it up on exit.
engine_was_up=0
"$DOCKER" info >/dev/null 2>&1 && engine_was_up=1

teardown() {
  echo "↓ tearing down dev DB..."
  "$DOCKER" compose -f "$COMPOSE" down >/dev/null 2>&1 || true
  if [ "$engine_was_up" -eq 0 ]; then
    echo "↓ stopping Docker engine..."
    "$DOCKER" desktop stop >/dev/null 2>&1 || true
    echo "✓ Docker off (no daemon, no GUI left running)"
  else
    echo "✓ dev DB down (engine left running — it was already up before this run)"
  fi
}
trap teardown EXIT

# 1. Start the engine headless if it isn't running.
if [ "$engine_was_up" -eq 0 ]; then
  # Windows bug: the Secrets Engine leaves a CORRUPTED unix-socket file behind on engine stop, and
  # the next start dies on 'remove engine.sock: The file cannot be accessed by the system' — forever,
  # every start, until the file is gone. Only cmd's `del` can remove the broken reparse point (rm and
  # PowerShell both fail on it). Harmless no-op when the file is absent or healthy.
  # No [ -e ] guard on purpose: stat() itself fails on the broken reparse point, so -e reads false
  # while the file very much exists. And no absolute path in the del: git-bash mangles it into a
  # cmd syntax error — cd + relative name is the form that actually deletes the thing.
  if [ -n "${LOCALAPPDATA:-}" ] && [ -d "$LOCALAPPDATA/docker-secrets-engine" ]; then
    (cd "$LOCALAPPDATA/docker-secrets-engine" && cmd //c "del /f /q engine.sock") >/dev/null 2>&1 || true
  fi
  echo "↑ starting Docker engine (headless)..."
  "$DOCKER" desktop start >/dev/null 2>&1 || true
  for i in $(seq 1 60); do
    "$DOCKER" info >/dev/null 2>&1 && break
    sleep 2
    [ "$i" -eq 60 ] && { echo "✗ Docker engine didn't come up in 2min"; exit 1; }
  done
  echo "✓ engine ready"
fi

# 2. Bring the DB container up on a FRESH volume (waits until healthy via the compose healthcheck).
# `down -v` first so every test run starts from an empty database: test:db:run then `migrate deploy`s
# the schema cleanly (no leaked fixture rows from a prior failed run, and no migrate-reset — which
# Prisma blocks under AI agents — needed).
echo "↑ starting dev Postgres container (fresh volume)..."
"$DOCKER" compose -f "$COMPOSE" down -v >/dev/null 2>&1 || true
"$DOCKER" compose -f "$COMPOSE" up -d --wait || { echo "✗ db:up failed"; exit 1; }

# 3. Run the requested command; propagate its exit code (trap still runs teardown).
echo "▶ $*"
"$@"
exit $?
