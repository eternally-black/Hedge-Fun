#!/usr/bin/env bash
# One-time bootstrap of the VPS2 streaming standby. Run as root on VPS2, after:
#
#   1. VPS1 publishes Postgres on 127.0.0.1:5432 (docker-compose.yml, deployed);
#   2. /root/.ssh/pg_replica exists here and its pubkey is in VPS1's authorized_keys as
#      restrict,port-forwarding,permitopen="127.0.0.1:5432" ...  (install-vps2.sh prints it);
#   3. pg-tunnel.service is up;
#   4. on VPS1, once:
#        CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '<pw>';
#        SELECT pg_create_physical_replication_slot('standby_vps2');
#   5. PG_REPLICA_PASSWORD=<pw> is in /opt/ops/.env.
#
# Re-running is safe: it refuses to touch a data directory that already exists, because a
# basebackup over a live standby is how you lose the thing you were protecting.
set -euo pipefail

DATA=/opt/standby/data
STACK=/opt/standby
ENV_FILE=/opt/ops/.env
IMAGE='postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
SLOT=standby_vps2
TUNNEL_PORT=15432

die() { echo "[standby-setup] $1" >&2; exit 1; }

[ -f "$STACK/docker-compose.yml" ] || die "install-vps2.sh has not placed $STACK/docker-compose.yml yet"
[ -d "$DATA" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ] && die "$DATA is not empty — refusing to overwrite an existing standby"

PW="$(grep -E '^PG_REPLICA_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
[ -n "$PW" ] || die "PG_REPLICA_PASSWORD is not set in $ENV_FILE"

systemctl is-active --quiet pg-tunnel.service || die "pg-tunnel.service is not running"
(exec 3<>/dev/tcp/127.0.0.1/$TUNNEL_PORT) 2>/dev/null || die "nothing is listening on 127.0.0.1:$TUNNEL_PORT — the tunnel is not forwarding"

mkdir -p "$DATA"
chown 70:70 "$DATA"      # the alpine image's postgres user
chmod 700 "$DATA"

echo "[standby-setup] base backup from the primary through the tunnel (93 MB class, seconds)"
# --host 127.0.0.1: the tunnel endpoint. -R writes standby.signal and primary_conninfo, so
# the container comes up already in recovery. -S binds it to the slot created on the primary,
# which is what keeps the WAL it still needs from being recycled underneath it.
docker run --rm --network host --user 70:70 \
  -e PGPASSWORD="$PW" \
  -v "$DATA:/var/lib/postgresql/data" \
  "$IMAGE" \
  pg_basebackup -h 127.0.0.1 -p "$TUNNEL_PORT" -U replicator \
                -D /var/lib/postgresql/data -R -S "$SLOT" -X stream -c fast -P

echo "[standby-setup] starting the standby"
( cd "$STACK" && docker compose up -d )

echo "[standby-setup] done. Check with: bash /opt/ops/ops/replica-check.sh -v"
