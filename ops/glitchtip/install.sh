#!/usr/bin/env bash
# One-shot idempotent installer/updater for the self-hosted GlitchTip stack. Run as root
# ON THE VPS. Re-running is the upgrade path: docker-compose.yml and tg-bridge.mjs are
# always copied over (from this script's directory); only an existing .env is preserved.
set -euo pipefail

DEST=/opt/glitchtip
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$DEST"

# Copy the stack files (overwrite = upgrade path).
cp "$SCRIPT_DIR/docker-compose.yml" "$DEST/docker-compose.yml"
cp "$SCRIPT_DIR/tg-bridge.mjs" "$DEST/tg-bridge.mjs"

# First run only: create .env from env.example with generated secrets, then remind the
# operator to fill in the Telegram + domain values before `up`.
if [ ! -f "$DEST/.env" ]; then
  sed \
    -e "s/^SECRET_KEY=.*/SECRET_KEY=$(openssl rand -hex 32)/" \
    -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" \
    "$SCRIPT_DIR/env.example" > "$DEST/.env"
  chmod 600 "$DEST/.env"
  echo "Created $DEST/.env — EDIT IT NOW to set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GLITCHTIP_DOMAIN."
fi

# Shared external network; the app stack's caddy joins it to reverse-proxy glitchtip-web:8000.
# Already exists on re-run => no-op.
docker network create glitchtip-shared 2>/dev/null || true

cd "$DEST"
docker compose up -d --wait

echo
echo "Next steps:"
echo "  1. Create the admin user:  docker compose exec web ./manage.py createsuperuser"
echo "  2. DNS: point glitchtip.hedgeyour.fun at this host (caddy terminates TLS)."
echo "  3. In GlitchTip > Project > Alerts > Webhooks, use exactly:  http://tg-bridge:8080"
