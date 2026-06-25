#!/usr/bin/env bash
# Ensure the WSL Postgres is running and reachable from Windows before dev/poll.
# WSL tears the VM down when no wsl.exe process is alive, so we (re)start the service.
set -e

# WSL-dev only. On a non-Windows host (e.g. the VPS) this script must do nothing —
# prod gets DATABASE_URL from the compose .env, never from this sed rewrite.
command -v wsl.exe >/dev/null || { echo "db-up: not WSL, skipping"; exit 0; }

wsl.exe -e bash -lc "sudo service postgresql start >/dev/null 2>&1; pg_isready -q" \
  || { echo "postgres: FAILED to start in WSL"; exit 1; }

# The Prisma query engine resolves 127.0.0.1 with happy-eyeballs and tries ::1, which
# WSL Postgres doesn't listen on — so it fails on loopback even when a TCP proxy works.
# Connecting straight to the WSL VM's IPv4 sidesteps that. The IP changes across WSL
# restarts, so rewrite DATABASE_URL's host in .env each run to the current one.
WSLIP=$(wsl.exe -e bash -lc "hostname -I | awk '{print \$1}'" | tr -d '\r')
[ -n "$WSLIP" ] || { echo "postgres: could not resolve WSL IP"; exit 1; }

# Replace the host:port in the DATABASE_URL line (any prior host) with the live WSL IP.
sed -i -E "s#(DATABASE_URL=\"postgresql://[^@]+@)[^/]+(/)#\1${WSLIP}:5432\2#" .env

echo "postgres: up (DATABASE_URL host -> ${WSLIP}:5432)"
