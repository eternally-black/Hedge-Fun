#!/usr/bin/env bash
# Deploy one tested release tuple: exact git commit + immutable GHCR digest.
set -euo pipefail

# Manual rollback/deploy may reset the tracked file that bash is still reading. Run a stable copy
# before any repository mutation; CI already supplies an exact temporary copy and sets this flag.
if [ -z "${HF_DEPLOY_BOOTSTRAP:-}" ]; then
  bootstrap_copy=$(mktemp "${TMPDIR:-/tmp}/hedgefun-deploy.XXXXXX")
  cp "${BASH_SOURCE[0]}" "$bootstrap_copy"
  set +e
  HF_DEPLOY_BOOTSTRAP=1 bash "$bootstrap_copy" "$@"
  bootstrap_code=$?
  set -e
  rm -f "$bootstrap_copy"
  exit "$bootstrap_code"
fi

ROOT="${HF_DEPLOY_ROOT:-/opt/hedgefun}"
STATE_DIR="${HF_STATE_DIR:-/var/lib/hedgefun}"
MARKER="$STATE_DIR/deploy-in-progress"
OVERRIDE="$ROOT/docker-compose.override.yml"
RELEASE_FILE="$ROOT/.deployed_release"
SHA_FILE="$ROOT/.deployed_sha"
RELEASE_TMP="$RELEASE_FILE.tmp.$$"
SHA_TMP="$SHA_FILE.tmp.$$"
STEP=init
ACTIVATION_STARTED=0
RECOVERING=0
PREV_SHA=
PREV_IMAGE_REF=
PREV_RELEASE_EXISTS=0
PREV_RELEASE_COPY=
PREV_SHA_EXISTS=0
PREV_SHA_COPY=
MIGRATE_ERR="${TMPDIR:-/tmp}/hf_migrate.$$"

cd "$ROOT"

notify() { bash ops/notify.sh "$1" "$2" 2>/dev/null || true; }
valid_sha() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }
valid_release_image() {
  [[ "${1:-}" =~ ^ghcr\.io/eternally-black/hedge-fun@sha256:[0-9a-f]{64}$ ]]
}
valid_runtime_image() {
  valid_release_image "${1:-}" || [[ "${1:-}" =~ ^sha256:[0-9a-f]{64}$ ]]
}

write_override() {
  local ref="$1" tmp="$OVERRIDE.tmp.$$"
  valid_runtime_image "$ref" || { echo "invalid runtime image ref" >&2; return 1; }
  umask 022
  printf 'services:\n  app:\n    image: "%s"\n  migrate:\n    image: "%s"\n  poller:\n    image: "%s"\n' \
    "$ref" "$ref" "$ref" > "$tmp"
  mv -f "$tmp" "$OVERRIDE"
}

read_previous_release() {
  local release_sha release_image cid
  PREV_SHA=$(git rev-parse HEAD 2>/dev/null || true)
  valid_sha "$PREV_SHA" || PREV_SHA=

  if [ -f "$RELEASE_FILE" ]; then
    PREV_RELEASE_COPY=$(mktemp "${TMPDIR:-/tmp}/hf-release-marker.XXXXXX")
    cp "$RELEASE_FILE" "$PREV_RELEASE_COPY"
    PREV_RELEASE_EXISTS=1
    release_sha=$(sed -n 's/^GIT_SHA=//p' "$RELEASE_FILE" | head -1)
    release_image=$(sed -n 's/^IMAGE_REF=//p' "$RELEASE_FILE" | head -1)
    if valid_sha "$release_sha" && valid_release_image "$release_image"; then
      PREV_SHA="$release_sha"
      PREV_IMAGE_REF="$release_image"
    fi
  fi
  if [ -f "$SHA_FILE" ]; then
    PREV_SHA_COPY=$(mktemp "${TMPDIR:-/tmp}/hf-sha-marker.XXXXXX")
    cp "$SHA_FILE" "$PREV_SHA_COPY"
    PREV_SHA_EXISTS=1
  fi

  # Controlled first adoption from the legacy :latest deployment: preserve the exact local
  # image ID. We do not claim or invent a registry digest for an image that predates release tuples.
  if [ -z "$PREV_IMAGE_REF" ]; then
    cid=$(docker compose ps -q app 2>/dev/null || true)
    if [ -n "$cid" ]; then
      PREV_IMAGE_REF=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)
      valid_runtime_image "$PREV_IMAGE_REF" || PREV_IMAGE_REF=
    fi
  fi
}

restore_marker() {
  local path="$1" existed="$2" copy="$3" tmp
  tmp="$path.restore.$$"
  if [ "$existed" -eq 1 ]; then
    cp "$copy" "$tmp" || return 1
    mv -f "$tmp" "$path" || return 1
  else
    rm -f "$path" || return 1
  fi
}

recover_previous() {
  [ "$ACTIVATION_STARTED" -eq 1 ] || return 0
  valid_sha "$PREV_SHA" || { notify CRIT "deploy recovery unavailable: previous git commit is unknown"; return 1; }
  valid_runtime_image "$PREV_IMAGE_REF" || { notify CRIT "deploy recovery unavailable: previous image identity is unknown"; return 1; }

  RECOVERING=1
  echo "[deploy] recovering previous config $PREV_SHA and image $PREV_IMAGE_REF" >&2
  git reset --hard "$PREV_SHA" >/dev/null || return 1
  # Regenerate the dedicated override from the confirmed release tuple. Copying a stale or
  # manually-edited override could restore previous git config with a different image.
  write_override "$PREV_IMAGE_REF" || return 1
  docker compose config --quiet || return 1
  docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile || return 1
  docker compose up -d --remove-orphans --wait --wait-timeout 180 --pull never || return 1
  if ! docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    docker compose up -d --force-recreate --pull never caddy || return 1
  fi
  docker compose up -d --wait --wait-timeout 60 --pull never caddy || return 1
  restore_marker "$RELEASE_FILE" "$PREV_RELEASE_EXISTS" "$PREV_RELEASE_COPY" || return 1
  restore_marker "$SHA_FILE" "$PREV_SHA_EXISTS" "$PREV_SHA_COPY" || return 1
  notify WARN "deploy failed; recovered previous release $PREV_SHA ($PREV_IMAGE_REF), database migrations were not downgraded"
  return 0
}

on_exit() {
  local code=$?
  trap - EXIT
  rm -f "$MIGRATE_ERR" "$RELEASE_TMP" "$SHA_TMP"
  if [ "$code" -ne 0 ] && [ "$RECOVERING" -eq 0 ]; then
    if [ "$ACTIVATION_STARTED" -eq 1 ]; then
      set +e
      recover_previous
      local recovery_code=$?
      if [ "$recovery_code" -ne 0 ]; then
        notify CRIT "deploy FAILED at step: $STEP (exit $code); automatic recovery also failed"
      else
        notify CRIT "deploy FAILED at step: $STEP (exit $code); previous release restored"
      fi
    else
      notify CRIT "deploy FAILED at step: $STEP (exit $code); live release was not changed"
    fi
  fi
  [ -n "$PREV_RELEASE_COPY" ] && rm -f "$PREV_RELEASE_COPY"
  [ -n "$PREV_SHA_COPY" ] && rm -f "$PREV_SHA_COPY"
  rm -f "$MARKER"
  exit "$code"
}
trap on_exit EXIT
mkdir -p "$STATE_DIR"
touch "$MARKER"

MODE="${1:-}"
TARGET_SHA="${2:-}"
TARGET_IMAGE="${3:-}"
case "$MODE" in
  deploy|rollback) ;;
  *) echo "usage: bash deploy.sh {deploy|rollback} <full-git-sha> <ghcr-image@sha256:digest>" >&2; exit 64 ;;
esac
valid_sha "$TARGET_SHA" || { echo "target must be a lowercase 40-character git SHA" >&2; exit 64; }
valid_release_image "$TARGET_IMAGE" || { echo "target image must be the HedgeFun GHCR repository at a sha256 digest" >&2; exit 64; }

# The workflow bootstraps the exact script through `git show`. Manual rollback intentionally uses
# the currently installed script, but still fetches and validates the requested release tuple.
STEP="release fetch"
git cat-file -e "$TARGET_SHA^{commit}" 2>/dev/null || git fetch --no-tags origin "$TARGET_SHA"
[ "$(git rev-parse "$TARGET_SHA^{commit}")" = "$TARGET_SHA" ] || { echo "git target did not resolve exactly" >&2; exit 1; }
if git cat-file -e "$TARGET_SHA:docker-compose.override.yml" 2>/dev/null; then
  echo "docker-compose.override.yml must remain untracked runtime release state" >&2
  exit 1
fi

set -a
. ./.env
set +a

# Keep production configuration drift visible without exposing values.
if [ -f .env.example ]; then
  missing=$(grep -oE '^[A-Z0-9_]+=' .env.example | cut -d= -f1 | while read -r key; do
    grep -qE "^${key}=" .env || echo "$key"
  done | paste -sd, -)
  [ -z "$missing" ] || notify WARN "deploy: $ROOT/.env lacks keys from .env.example: $missing"
fi

STEP="ghcr login"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

STEP="image verification"
docker pull "$TARGET_IMAGE"
image_revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$TARGET_IMAGE")
[ "$image_revision" = "$TARGET_SHA" ] || {
  echo "image revision mismatch: expected $TARGET_SHA, got ${image_revision:-<missing>}" >&2
  exit 1
}

read_previous_release
ACTIVATION_STARTED=1
action=deploy
[ "$MODE" = rollback ] && action=rollback
notify INFO "$action started: $TARGET_SHA ($TARGET_IMAGE)"

STEP="config activation"
git reset --hard "$TARGET_SHA"
write_override "$TARGET_IMAGE"
docker compose config --quiet

STEP="caddyfile validation"
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile

STEP="install-ops"
if [ "${HF_SKIP_HOST_OPS:-0}" = 1 ]; then
  :
elif [ "$(id -u)" -eq 0 ]; then
  bash ops/vps/install-ops.sh
elif sudo -n true 2>/dev/null; then
  sudo -n bash ops/vps/install-ops.sh
else
  echo "[deploy] host hardening unchanged (no root or passwordless sudo)"
fi

STEP="db up"
docker compose up -d --wait db

STEP="predeploy backup"
if [ "${HF_SKIP_BACKUP:-0}" != 1 ] && { [ -f "$RELEASE_FILE" ] || [ -f "$SHA_FILE" ]; }; then
  bash ops/vps/backup.sh predeploy
fi

# Do not let old money workers operate against a schema while the new release migrates it.
STEP="old workers stop"
docker compose stop app poller

STEP="migrate"
if ! docker compose run --rm migrate npx prisma migrate deploy 2>"$MIGRATE_ERR"; then
  if grep -q 'P3005' "$MIGRATE_ERR"; then
    docker compose run --rm migrate npx prisma migrate resolve --applied 0_init
    docker compose run --rm migrate npx prisma migrate deploy
  else
    cat "$MIGRATE_ERR" >&2
    exit 1
  fi
fi
rm -f "$MIGRATE_ERR"

STEP="services up"
docker compose up -d --remove-orphans --wait --wait-timeout 180

STEP="running image verification"
expected_id=$(docker image inspect --format '{{.Id}}' "$TARGET_IMAGE")
for svc in app poller; do
  cid=$(docker compose ps -q "$svc")
  [ -n "$cid" ] || { echo "$svc has no running container" >&2; exit 1; }
  actual_id=$(docker inspect --format '{{.Image}}' "$cid")
  [ "$actual_id" = "$expected_id" ] || { echo "$svc is not running the expected image" >&2; exit 1; }
done

STEP="caddy reload"
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
  || docker compose up -d --force-recreate caddy
docker compose up -d --wait --wait-timeout 60 caddy

# Commit release identity only after every service and ingress health gate passed.
STEP="release marker"
printf 'GIT_SHA=%s\nIMAGE_REF=%s\n' "$TARGET_SHA" "$TARGET_IMAGE" > "$RELEASE_TMP"
printf '%s\n' "$TARGET_SHA" > "$SHA_TMP"
# `.deployed_release` is authoritative and moves last. A crash between renames can only leave the
# compatibility SHA ahead; it cannot claim the new release tuple before both marker files exist.
mv -f "$SHA_TMP" "$SHA_FILE"
mv -f "$RELEASE_TMP" "$RELEASE_FILE"
ACTIVATION_STARTED=0

docker image prune -f >/dev/null 2>&1 || true
notify OK "$action done: $TARGET_SHA ($TARGET_IMAGE)"
echo "[deploy] done — $TARGET_SHA $TARGET_IMAGE"
docker compose ps || true
