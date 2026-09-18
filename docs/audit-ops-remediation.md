# Operations audit remediation (F8-F10)

## F8: release identity and rollback

Production deploys use one immutable release tuple:

```text
GIT_SHA=<40 lowercase hex characters>
IMAGE_REF=ghcr.io/eternally-black/hedge-fun@sha256:<64 lowercase hex characters>
```

CI exposes the digest returned by `docker/build-push-action` and passes it with the full
`github.sha`. The image carries `org.opencontainers.image.revision=<github.sha>`. The VPS fetches
that exact commit, executes the copy of `deploy.sh` stored in it, pulls the exact digest, and rejects
the release if the OCI revision label differs.

`deploy.sh` writes `docker-compose.override.yml` at runtime. Docker Compose loads this conventional
override automatically, so watchdog `docker compose up` calls keep using the deployed digest. The
file is intentionally runtime state and must remain untracked. The base Compose file points at a
fail-closed `release-pin-required` placeholder when neither the runtime override nor an explicit
`HF_IMAGE_REF` exists. Secret `.env` contents are never rewritten.

Before activation, deployment records the current full commit, image identity, and runtime
override. It validates the new Caddy config, starts the database, takes the existing predeploy
backup, stops the old app and poller, applies additive migrations, and starts the new release. The
release markers are written only after app, poller, and ingress checks pass. A failed activation
restores the previous tracked config and exact image and reloads Caddy; it never reverses a database
migration.

The release record is `.deployed_release`; `.deployed_sha` remains as a full-SHA compatibility
marker. First adoption from the legacy deployment captures the running container's exact local image
ID without claiming that it has a known registry digest.

Manual rollback requires a known, previously tested tuple:

```bash
bash deploy.sh rollback <full-git-sha> ghcr.io/eternally-black/hedge-fun@sha256:<digest>
```

Rollback does not retag or pull `:latest` and does not downgrade the database.

## F9: offsite backup acceptance

`ops/vps2/backup-pull.sh` reports success only when rsync succeeds and the destination contains a
fresh, nonempty, encrypted daily HedgeFun artifact with its matching checksum:

```text
hedgefun-YYYYMMDD.dump.enc
hedgefun-YYYYMMDD.dump.enc.sha256
```

The sidecar must contain exactly one lowercase SHA-256 value, and every recognized pair present in
the destination must verify. Empty destinations, plaintext artifacts, half-pairs, bad hashes,
future dates, and stale daily backups fail. Predeploy snapshots are verified when present but never
count as the required daily backup.

VPS1 must therefore set `BACKUP_ENC_PASSPHRASE` in `/opt/hedgefun/.env`; the source backup script
uses that value to produce `.dump.enc`. An unset passphrase produces plaintext and deliberately
causes the offsite pull gate to fail.

Freshness defaults to 48 hours from the UTC date encoded in the filename. This allows one delayed
daily pull while still failing before a second daily cycle is missed. Set
`BACKUP_PULL_MAX_AGE_HOURS` to an integer from 24 through 168 to change it. Set
`BACKUP_PULL_REQUIRE_GLITCHTIP=1` when the VPS1 GlitchTip stack is configured and a fresh
`glitchtip-YYYYMMDD.dump.enc` pair must also gate success. These values belong in `/opt/ops/.env`.

A corrupt existing pair is quarantined and fetched once more. Retention runs only after validation,
removes only recognized pairs older than 28 days, and is followed by another freshness check. The
healthcheck URL is passed to curl on stdin. Set `BACKUP_PULL_HC_FAIL_URL` for providers with an
explicit failure endpoint. Healthchecks.io-style URLs derive `<success-url>/fail` automatically;
other providers receive only the normal success ping unless a failure URL is configured.

## F10: isolated database test helper

`scripts/with-docker-db.sh` uses `docker-compose.test.yml`, a unique `hf-testdb-*` Compose project,
a container-scoped tmpfs database, and a Docker-assigned loopback port. It always supplies fixed
test credentials and replaces any caller `DATABASE_URL` with a URL for `127.0.0.1`, the assigned
port, and the explicit `hedgefun_test` database.

Cleanup is limited to the generated project and checks Docker's Compose ownership label before
running `down -v`. The helper never touches `docker-compose.dev.yml`, never deletes global Docker
state, and never stops the Docker daemon. If it starts Docker Desktop, it leaves the shared engine
running.

Use the Node launcher from cross-platform npm scripts:

```bash
node scripts/with-docker-db.cjs npm run test:db:run
```

On Windows it resolves Git Bash explicitly from the Git for Windows installation and refuses to
fall back to WSL `bash.exe`; on POSIX it invokes `bash` normally.

Offline contract tests run without a Docker daemon or network:

```bash
bash scripts/test-ops-audit.sh
```
