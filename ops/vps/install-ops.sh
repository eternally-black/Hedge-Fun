#!/usr/bin/env bash
# Idempotent host hardening + ops unit installer. Invoked by deploy.sh on every deploy
# (which also makes it the config-drift reconciler for everything below) and runnable by
# hand. Root only. Every step is guarded — re-running must change nothing when nothing
# drifted.
set -euo pipefail

HEDGEFUN_DIR="${HEDGEFUN_DIR:-/opt/hedgefun}"
UNIT_SRC="$HEDGEFUN_DIR/ops/vps/systemd"
NOTIFY="$HEDGEFUN_DIR/ops/notify.sh"

notify() { bash "$NOTIFY" "$1" "$2" || true; }

# --- sysctls -----------------------------------------------------------------
SYSCTL_FILE=/etc/sysctl.d/90-hedgefun.conf
SYSCTL_WANT="# managed by hedgefun install-ops.sh
kernel.panic = 10
kernel.panic_on_oops = 1
vm.swappiness = 10"
if [ ! -f "$SYSCTL_FILE" ] || [ "$(cat "$SYSCTL_FILE")" != "$SYSCTL_WANT" ]; then
  printf '%s\n' "$SYSCTL_WANT" > "$SYSCTL_FILE"
  sysctl -p "$SYSCTL_FILE" >/dev/null
  echo "[install-ops] sysctls applied"
fi

# --- swap (2G) ---------------------------------------------------------------
if ! swapon --show | grep -q .; then
  avail_kb=$(df --output=avail / | tail -1 | tr -dc '0-9')
  if [ "${avail_kb:-0}" -lt $(( 20 * 1024 * 1024 )) ]; then
    notify WARN "install-ops: skipping swapfile — less than 20G free on / (${avail_kb}K)"
  else
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -qE '^/swapfile\s' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "[install-ops] 2G swapfile created and enabled"
  fi
fi

# --- docker daemon.json ------------------------------------------------------
# Log rotation for NEW containers + live-restore (containers survive daemon restarts).
# Per-service `logging:` blocks in the compose files are the primary rotation mechanism
# (they cover never-recreated containers like db); this is the safety net for anything else.
DAEMON_FILE=/etc/docker/daemon.json
DAEMON_WANT='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}'
if [ -f "$DAEMON_FILE" ] && [ "$(cat "$DAEMON_FILE")" != "$DAEMON_WANT" ]; then
  # Merge-safe: an unexpected daemon.json means a human configured something — do not
  # clobber it from a deploy script. Alert and leave it alone.
  notify WARN "install-ops: unexpected /etc/docker/daemon.json present — manual merge needed (log rotation + live-restore)"
elif [ ! -f "$DAEMON_FILE" ]; then
  tmp=$(mktemp)
  printf '%s\n' "$DAEMON_WANT" > "$tmp"
  if dockerd --validate --config-file "$tmp" >/dev/null 2>&1; then
    mkdir -p /etc/docker
    mv "$tmp" "$DAEMON_FILE"
    # SIGHUP reload applies live-restore + default log-opts without touching containers.
    systemctl reload docker 2>/dev/null || kill -HUP "$(cat /var/run/docker.pid 2>/dev/null)" 2>/dev/null \
      || notify WARN "install-ops: daemon.json written but docker reload failed — restart docker in a maintenance window"
    echo "[install-ops] docker daemon.json installed"
  else
    rm -f "$tmp"
    notify CRIT "install-ops: generated daemon.json failed dockerd --validate — NOT applied"
  fi
fi

# --- NTP ---------------------------------------------------------------------
timedatectl set-ntp true 2>/dev/null || true

# --- state/backup dirs -------------------------------------------------------
mkdir -p /var/lib/hedgefun "$HEDGEFUN_DIR/backups"
chmod 700 "$HEDGEFUN_DIR/backups"
# deploy.sh runs backup.sh as the deploy user; a root-owned 0700 dir makes the pre-migration
# dump EPERM and aborts every deploy after the first. Hand it to the deploy account.
chown "$(stat -c %U:%G "$HEDGEFUN_DIR")" "$HEDGEFUN_DIR/backups"
# notify.sh appends with `|| true`, so a root-owned file silently drops every deploy-user alert.
touch /var/log/hedgefun-notify.log
chown "$(stat -c %U:%G "$HEDGEFUN_DIR")" /var/log/hedgefun-notify.log
chmod 664 /var/log/hedgefun-notify.log
# Install the logrotate config for the alert log.
install -m 0644 "$(dirname "$0")/logrotate-hedgefun-notify" /etc/logrotate.d/hedgefun-notify
# /var/lib/hedgefun is shared: root writes the watchdog lock here from systemd, and deploy.sh writes
# its in-progress marker here as the DEPLOY user over SSH from CI. This installer runs as root, so
# without the chown the directory ends up root-owned and the next deploy dies on
# `touch: Permission denied` — an install-time action breaking the deploy path, which is exactly the
# kind of failure that looks like a CI problem and is not. Root ignores the mode, so handing it to
# the deploy account costs nothing on the systemd side.
chown "$(stat -c %U:%G "$HEDGEFUN_DIR")" /var/lib/hedgefun
chmod 775 /var/lib/hedgefun

# --- systemd units -----------------------------------------------------------
changed=0
for unit in "$UNIT_SRC"/*.service "$UNIT_SRC"/*.timer; do
  [ -f "$unit" ] || continue
  dst="/etc/systemd/system/$(basename "$unit")"
  if [ ! -f "$dst" ] || ! cmp -s "$unit" "$dst"; then
    cp "$unit" "$dst"
    changed=1
  fi
done
[ "$changed" -eq 1 ] && systemctl daemon-reload

systemctl enable --now hedgefun-watchdog.timer >/dev/null 2>&1
systemctl enable --now hedgefun-backup.timer   >/dev/null 2>&1
# enable only — starting it now would send a spurious "VPS booted" alert.
systemctl enable hedgefun-boot-notify.service  >/dev/null 2>&1

echo "[install-ops] ok"
