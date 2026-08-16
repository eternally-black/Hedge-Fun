#!/usr/bin/env bash
# Invoked by GitHub Actions over SSH (and runnable by hand). Idempotent.
# Lives at /opt/hedgefun/deploy.sh on the VPS.
#
# Pull-model: the image is built + pushed to GHCR by the runner. The VPS only
# logs in, pulls the fresh :latest, and recreates services. No build here.
set -euo pipefail

cd /opt/hedgefun

# Telegram notify + failure trap. STEP tracks where we are so a red deploy names its step.
# The deploy-in-progress marker tells the watchdog (hedgefun-watchdog.sh) to stand down
# while services are deliberately being recreated; removed on any exit.
STEP="init"
MARKER=/var/lib/hedgefun/deploy-in-progress
notify() { bash ops/notify.sh "$1" "$2" 2>/dev/null || true; }
on_exit() {
  code=$?
  rm -f "$MARKER"
  if [ "$code" -ne 0 ]; then notify CRIT "deploy FAILED at step: $STEP (exit $code)"; fi
}
trap on_exit EXIT
mkdir -p /var/lib/hedgefun && touch "$MARKER"

# Scripted rollback: `bash deploy.sh rollback <sha-short>` repins :latest to a prior immutable
# image (CI pushes :sha-<short> for every build) and re-ups — no rebuild, deterministic. Find SHAs
# in the repo's GHCR Packages tab; the currently-live one is recorded in .deployed_sha each deploy.
if [ "${1:-}" = "rollback" ]; then
  STEP="rollback"
  TARGET="${2:?usage: bash deploy.sh rollback <sha-short>}"
  IMG="ghcr.io/eternally-black/hedge-fun"
  set -a; . ./.env; set +a
  notify WARN "rollback to $TARGET started"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
  echo "[rollback] pulling $IMG:$TARGET and republishing as :latest"
  docker pull "$IMG:$TARGET"
  docker tag "$IMG:$TARGET" "$IMG:latest"
  docker compose up -d --remove-orphans --wait --wait-timeout 180
  # Record what is live NOW. The normal path writes this at the end, but rollback exits before it,
  # so the file kept naming the build we just rolled AWAY from — read during an incident, per the
  # contract at the top of this file, that points the next on-call straight back at the bad sha.
  # The tag format is :sha-<git-short>, which is what the normal path writes, so the two compare.
  echo "${TARGET#sha-}" > .deployed_sha
  echo "[rollback] done — live: $TARGET"
  notify OK "rollback done — live: $TARGET"
  docker compose ps
  exit 0
fi

STEP="git sync"
echo "[deploy] syncing repo (compose/Caddyfile/this script track main)"
git fetch --prune origin
git reset --hard origin/main     # mirror main; NOT used to build — only to keep infra files in sync

# Load .env so GHCR_USER / GHCR_TOKEN (read:packages PAT) are available for the login.
set -a; . ./.env; set +a
notify INFO "deploy started → $(git rev-parse --short HEAD)"

# Warn (not fail) on .env drift: a new key in .env.example that prod .env lacks means some
# feature (alerts, error tracking, dead-man pings) is silently off.
if [ -f .env.example ]; then
  missing=$(grep -oE '^[A-Z0-9_]+=' .env.example | cut -d= -f1 | while read -r k; do
    grep -qE "^$k=" .env || echo "$k"
  done | paste -sd, -)
  if [ -n "$missing" ]; then
    notify WARN "deploy: /opt/hedgefun/.env lacks keys from .env.example: $missing"
  fi
fi

STEP="ghcr login"
echo "[deploy] logging in to GHCR"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

STEP="image pull"
echo "[deploy] pulling image"
docker compose pull              # pulls ghcr.io/eternally-black/hedge-fun:latest for app/migrate/poller

# A bad Caddyfile would take down the sole ingress for app + GlitchTip on recreate.
# Validate with the already-pulled caddy image and abort the deploy instead.
STEP="caddyfile validation"
echo "[deploy] validating Caddyfile"
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile

STEP="install-ops"
# Host hardening is a PROVISIONING step, not a per-deploy one: it writes sysctls, /etc/docker,
# systemd units and /var/log, all of which need root. CI deploys as the unprivileged `deploy` user
# (that is the point — a deploy key that can restart containers should not be able to rewrite the
# host), so running it here failed the whole pipeline on `Permission denied` the moment ops/ landed
# on the box. It is idempotent and changes rarely, so it runs when we actually have the rights and
# is otherwise announced and skipped rather than taking the deploy down with it.
if [ "$(id -u)" -eq 0 ]; then
  echo "[deploy] applying host hardening + ops units (idempotent)"
  bash ops/vps/install-ops.sh
elif sudo -n true 2>/dev/null; then
  echo "[deploy] applying host hardening + ops units via sudo (idempotent)"
  sudo -n bash ops/vps/install-ops.sh
else
  echo "[deploy] SKIPPED host hardening — not root and no passwordless sudo."
  echo "[deploy] run once as root after changing ops/: bash /opt/hedgefun/ops/vps/install-ops.sh"
fi

STEP="db up"
echo "[deploy] ensuring database is up"
docker compose up -d --wait db

# Verified snapshot BEFORE migrations touch a real-money schema. Skipped on the very first
# deploy of a fresh host (no .deployed_sha yet -> empty DB, dump would trip the size floor).
STEP="predeploy backup"
if [ -f .deployed_sha ]; then
  echo "[deploy] pre-migration backup"
  bash ops/vps/backup.sh predeploy
fi
STEP="migrate"

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

STEP="services up"
echo "[deploy] (re)creating services (migrate service re-runs deploy as a no-op gate, then app/poller)"
# --wait: success means READY (healthchecks green), not merely started. A service that
# never turns healthy fails the deploy loudly instead of leaving a zombie prod.
docker compose up -d --remove-orphans --wait --wait-timeout 180

STEP="prune"
echo "[deploy] pruning dangling images"
docker image prune -f

echo "[deploy] done — live image sha-$(git rev-parse --short HEAD)"
git rev-parse --short HEAD > .deployed_sha 2>/dev/null || true
notify OK "deploy done — live: sha-$(git rev-parse --short HEAD)"
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
