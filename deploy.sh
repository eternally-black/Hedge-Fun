#!/usr/bin/env bash
# Invoked by GitHub Actions over SSH (and runnable by hand). Idempotent.
# Lives at /opt/hedgefun/deploy.sh on the VPS.
#
# Pull-model: the image is built + pushed to GHCR by the runner. The VPS only
# logs in, pulls the fresh :latest, and recreates services. No build here.
set -euo pipefail

cd /opt/hedgefun

echo "[deploy] syncing repo (compose/Caddyfile/this script track main)"
git fetch --prune origin
git reset --hard origin/main     # mirror main; NOT used to build — only to keep infra files in sync

# Load .env so GHCR_USER / GHCR_TOKEN (read:packages PAT) are available for the login.
set -a; . ./.env; set +a

echo "[deploy] logging in to GHCR"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

echo "[deploy] pulling image"
docker compose pull              # pulls ghcr.io/eternally-black/hedge-fun:latest for app/migrate/poller

echo "[deploy] (re)creating changed services"
docker compose up -d --remove-orphans   # migrate one-shot runs, then app/poller

echo "[deploy] pruning dangling images"
docker image prune -f

echo "[deploy] done"
docker compose ps

# ---------------------------------------------------------------------------
# ROLLBACK: deploy always tracks :latest. To roll back to a previous build,
# pull its immutable SHA tag and republish it as :latest, then re-up:
#   docker pull ghcr.io/eternally-black/hedge-fun:sha-<short>
#   docker tag  ghcr.io/eternally-black/hedge-fun:sha-<short> ghcr.io/eternally-black/hedge-fun:latest
#   docker compose up -d
# (SHA tags are produced by the build job; find them in the repo's Packages tab.)
# ---------------------------------------------------------------------------
