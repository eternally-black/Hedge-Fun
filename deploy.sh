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

echo "[deploy] ensuring database is up"
docker compose up -d db

# Apply migrations, baseline-aware. A legacy db-push database has the tables but no
# _prisma_migrations history, so `migrate deploy` would try to re-create existing tables and fail
# with Prisma error P3005. Detect P3005 on the deploy output, baseline 0_init once (the live tables
# already match it), then re-deploy. No-op on every subsequent deploy and on a fresh database (where
# the first `migrate deploy` simply creates everything). Running it here (not only in the migrate
# service) lets us recover from the P3005 first-adoption case before app/poller start.
echo "[deploy] applying migrations (baseline-aware)"
if ! docker compose run --rm migrate npx prisma migrate deploy 2>/tmp/hf_migrate.err; then
  if grep -q 'P3005' /tmp/hf_migrate.err; then
    echo "[deploy] adopting Prisma Migrate: baselining 0_init on the existing db-push database"
    docker compose run --rm migrate npx prisma migrate resolve --applied 0_init
    docker compose run --rm migrate npx prisma migrate deploy
  else
    echo "[deploy] migrate deploy failed:"; cat /tmp/hf_migrate.err; rm -f /tmp/hf_migrate.err; exit 1
  fi
fi
rm -f /tmp/hf_migrate.err

echo "[deploy] (re)creating services (migrate service re-runs deploy as a no-op gate, then app/poller)"
docker compose up -d --remove-orphans

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
