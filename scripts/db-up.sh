#!/usr/bin/env bash
# Ensure the WSL Postgres is running and reachable from Windows before dev/poll.
# WSL tears the VM down when no wsl.exe process is alive, so we (re)start the service.
set -e
wsl.exe -e bash -lc "sudo service postgresql start >/dev/null 2>&1; pg_isready -q" \
  && echo "postgres: up (127.0.0.1:5432)" \
  || { echo "postgres: FAILED to start in WSL"; exit 1; }
