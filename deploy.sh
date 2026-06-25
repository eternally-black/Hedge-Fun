#!/usr/bin/env bash
# Invoked by GitHub Actions over SSH (and runnable by hand). Idempotent.
# Lives at /opt/hedgefun/deploy.sh on the VPS.
set -euo pipefail

cd /opt/hedgefun

echo "[deploy] fetching origin/main"
git fetch --prune origin
git reset --hard origin/main          # mirror main exactly; never blocked by local drift

SHA="$(git rev-parse --short HEAD)"
echo "[deploy] building hedgefun (${SHA})"
# build.args (NEXT_PUBLIC_PRIVY_APP_ID) are interpolated from /opt/hedgefun/.env by compose.
docker compose build app
docker tag hedgefun:latest "hedgefun:${SHA}"   # labelled snapshot: rollback + future Sentry release

echo "[deploy] applying schema + (re)creating changed services"
docker compose up -d --remove-orphans          # migrate one-shot runs, then app/poller

echo "[deploy] pruning dangling images"
docker image prune -f

echo "[deploy] done: ${SHA}"
docker compose ps
