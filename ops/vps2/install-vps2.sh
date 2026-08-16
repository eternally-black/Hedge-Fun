#!/usr/bin/env bash
# One-shot idempotent installer for the VPS2 monitoring host. Run as root ON VPS2 from a
# copy of the repo (scp -r ops/ vps2:/root/hedgefun-ops && bash /root/hedgefun-ops/vps2/install-vps2.sh).
# Re-running is the upgrade path: stack files and scripts are always overwritten; the two
# .env files are preserved.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../ops/vps2
OPS_ROOT="$(dirname "$SRC")"                          # .../ops
STACK=/opt/glitchtip                                  # dir name = compose project name the watchdog expects
OPS=/opt/ops

# --- light host hardening ----------------------------------------------------
cat > /etc/sysctl.d/90-hedgefun.conf <<'EOF'
# managed by hedgefun install-vps2.sh
kernel.panic = 10
kernel.panic_on_oops = 1
vm.swappiness = 10
EOF
sysctl -p /etc/sysctl.d/90-hedgefun.conf >/dev/null
timedatectl set-ntp true 2>/dev/null || true

# --- ops scripts + env -------------------------------------------------------
mkdir -p "$OPS/ops/vps" /var/lib/hedgefun /opt/backups/hedgefun
chmod 700 /opt/backups/hedgefun
cp "$OPS_ROOT/notify.sh"                "$OPS/ops/notify.sh"
cp "$OPS_ROOT/vps/hedgefun-watchdog.sh" "$OPS/ops/vps/hedgefun-watchdog.sh"
cp "$SRC/uptime-guard.sh"               "$OPS/ops/uptime-guard.sh"
cp "$SRC/backup-pull.sh"                "$OPS/ops/backup-pull.sh"
if [ ! -f "$OPS/.env" ]; then
  cp "$SRC/ops-env.example" "$OPS/.env"
  chmod 600 "$OPS/.env"
  echo ">>> Created $OPS/.env — fill TELEGRAM_*, BACKUP_PULL_SOURCE, CONTABO_* now."
fi

# --- systemd -----------------------------------------------------------------
changed=0
for unit in "$SRC"/systemd/*.service "$SRC"/systemd/*.timer; do
  dst="/etc/systemd/system/$(basename "$unit")"
  if [ ! -f "$dst" ] || ! cmp -s "$unit" "$dst"; then cp "$unit" "$dst"; changed=1; fi
done
[ "$changed" -eq 1 ] && systemctl daemon-reload
systemctl enable --now vps2-watchdog.timer uptime-guard.timer backup-pull.timer >/dev/null 2>&1

# --- backup-pull ssh key -----------------------------------------------------
if [ ! -f /root/.ssh/backup_pull ]; then
  ssh-keygen -t ed25519 -N "" -f /root/.ssh/backup_pull -C "vps2-backup-pull" >/dev/null
  echo ">>> Generated /root/.ssh/backup_pull. On VPS1, append to /root/.ssh/authorized_keys"
  echo "    (restricted to rsync-read of the backups dir):"
  echo "    command=\"rsync --server --sender -logDtprze.iLsfxC . /opt/hedgefun/backups/\",restrict $(cat /root/.ssh/backup_pull.pub)"
fi

# --- monitoring stack --------------------------------------------------------
mkdir -p "$STACK"
cp "$SRC/docker-compose.yml" "$STACK/docker-compose.yml"
cp "$SRC/Caddyfile"          "$STACK/Caddyfile"
cp "$SRC/tg-bridge.mjs"      "$STACK/tg-bridge.mjs"
if [ ! -f "$STACK/.env" ]; then
  sed \
    -e "s/^SECRET_KEY=.*/SECRET_KEY=$(openssl rand -hex 32)/" \
    -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" \
    "$SRC/env.example" > "$STACK/.env"
  chmod 600 "$STACK/.env"
  echo ">>> Created $STACK/.env — set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID."
fi
( cd "$STACK" && docker compose up -d )

echo
echo "Next steps:"
echo "  1. DNS: ingest.hedgeyour.fun AND push.hedgeyour.fun -> this host."
echo "  2. GlitchTip admin:  cd $STACK && docker compose exec web ./manage.py createsuperuser"
echo "     Then: org + project -> DSN -> SENTRY_DSN in VPS1:/opt/hedgefun/.env;"
echo "     alert rule -> webhook -> http://tg-bridge:8080"
echo "  3. Kuma UI is NOT public (first visitor would claim the admin account). From your"
echo "     laptop: ssh -L 3001:127.0.0.1:3001 root@<vps2>  then open http://127.0.0.1:3001"
echo "     Create the admin there, then add monitors:"
echo "     - HTTP https://app.hedgeyour.fun/api/health (keyword/status 200)"
echo "     - PUSH monitors for poller/backup/watchdog -> paste their /api/push/... URLs"
echo "       into VPS1:/opt/hedgefun/.env as POLLER_HC_URL / BACKUP_HC_URL / WATCHDOG_HC_URL"
echo "     - Telegram notification channel (bot token + chat id)"
echo "  4. Fill $OPS/.env; install the printed backup_pull key line on VPS1; test:"
echo "     bash $OPS/ops/backup-pull.sh && ls /opt/backups/hedgefun"
echo "  5. AUTO_REBOOT stays 0 until a staged failure drill passes (see ops/vps2/README.md)."
