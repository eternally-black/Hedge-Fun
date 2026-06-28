#!/usr/bin/env bash
# Invoked by GitHub Actions over SSH (and runnable by hand). Idempotent.
# Lives at /opt/hedgefun/deploy.sh on the VPS.
#
# Pull-model: the image is built + pushed to GHCR by the runner. The VPS only
# logs in, pulls the fresh :latest, and recreates services. No build here.
set -euo pipefail

cd /opt/hedgefun

# Scripted rollback: `bash deploy.sh rollback <sha-short>` repins :latest to a prior immutable
# image (CI pushes :sha-<short> for every build) and re-ups — no rebuild, deterministic. Find SHAs
# in the repo's GHCR Packages tab; the currently-live one is recorded in .deployed_sha each deploy.
if [ "${1:-}" = "rollback" ]; then
  TARGET="${2:?usage: bash deploy.sh rollback <sha-short>}"
  IMG="ghcr.io/eternally-black/hedge-fun"
  set -a; . ./.env; set +a
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
  echo "[rollback] pulling $IMG:$TARGET and republishing as :latest"
  docker pull "$IMG:$TARGET"
  docker tag "$IMG:$TARGET" "$IMG:latest"
  docker compose up -d --remove-orphans
  echo "[rollback] done — live: $TARGET"
  docker compose ps
  exit 0
fi

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

echo "[deploy] done — live image sha-$(git rev-parse --short HEAD)"
git rev-parse --short HEAD > .deployed_sha 2>/dev/null || true
docker compose ps

# ---------------------------------------------------------------------------
# ROLLBACK is now scripted:  bash deploy.sh rollback <sha-short>
#   -> pulls the immutable :sha-<short>, repins :latest, re-ups (no rebuild, deterministic).
# The currently-live SHA is recorded in .deployed_sha on each deploy; older SHA tags live in the
# repo's GHCR Packages tab. Manual equivalent, if ever needed:
#   docker pull ghcr.io/eternally-black/hedge-fun:sha-<short>
#   docker tag  ghcr.io/eternally-black/hedge-fun:sha-<short> ghcr.io/eternally-black/hedge-fun:latest
#   docker compose up -d
# ---------------------------------------------------------------------------
