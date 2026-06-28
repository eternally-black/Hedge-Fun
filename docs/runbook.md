# HedgeFun — Ops Runbook

Production = Docker Compose on a VPS (`/opt/hedgefun`). The image is built in GitHub
Actions, pushed to GHCR, and pulled by `deploy.sh`. Caddy is the only public ingress;
Postgres stays on the internal Docker network. VPS host/SSH details: see deploy secrets /
team memory.

## Architecture at a glance

One image (`ghcr.io/eternally-black/hedge-fun:latest`) runs in **three modes**; five
compose services (`docker-compose.yml`):

- **app** — `node server.js` (Next.js standalone). No host port; Caddy proxies to
  `app:3000` over the internal net. Healthcheck: `/api/me` returns 401/200 = alive.
- **poller** — `node dist/poller.cjs`. F4 settlement loop. Healthcheck: heartbeat file
  fresher than 180s (3× the 60s tick); stale → `restart: unless-stopped` fires.
- **migrate** — one-shot `npx prisma migrate deploy`, exits 0. app/poller `depends_on` it
  via `service_completed_successfully`, so they never start against an un-migrated DB.
- **db** — `postgres:16-alpine`, internal-only (no published port), `pgdata` volume.
- **caddy** — `caddy:2-alpine`, ports 80/443, auto-TLS, sole public ingress.

Env comes from a sibling `/opt/hedgefun/.env` (mode 600, not in git).

## Deploy

Push to `main` → `.github/workflows/deploy.yml`:

1. **test gate** — `npm run lint` + `npm test` (DB-free units) + `npm run test:db:run`
   (DB-backed money/economy). Build `needs: test`, so a logic regression can't ship.
2. **build** — build image on the runner, push to GHCR as `:latest` and `:sha-<short>`
   (the rollback handle). `linux/amd64`, `provenance: false` (avoids a multi-arch index
   plain `docker pull`/compose chokes on).
3. **deploy** — gated to `main`; SSHes the VPS and runs `bash deploy.sh`.

What `deploy.sh` does (idempotent):

- `git fetch` + `git reset --hard origin/main` — syncs infra files only (compose /
  Caddyfile / this script); **not** used to build.
- GHCR login (`GHCR_USER` / `GHCR_TOKEN` from `.env`) → `docker compose pull`.
- Brings up `db`, then **baseline-aware `migrate deploy`** (see Schema changes).
- `docker compose up -d --remove-orphans` → `docker image prune -f`.
- Records the live SHA in `.deployed_sha`.

A feature-branch / manual `workflow_dispatch` run only builds + pushes — the deploy job is
hard-gated to `main` and never touches prod.

## Rollback

```bash
bash deploy.sh rollback <sha-short>
```

Pulls the immutable `:sha-<short>`, repins it as `:latest`, and re-ups — no rebuild,
deterministic. The currently-live SHA is in `/opt/hedgefun/.deployed_sha`; older SHA tags
are in the repo's GHCR **Packages** tab.

## Schema changes

1. Edit `prisma/schema.prisma`.
2. `npm run db:migrate` locally — creates a migration in `prisma/migrations/`.
3. Commit it. On deploy, the `migrate` service runs `prisma migrate deploy`.

Never hand-edit prod. `db push` is **dev-only** (it has no migration history and would
diverge prod). The one-time legacy baseline is automatic: a db-push-origin database has the
tables but no `_prisma_migrations` history, so the first `migrate deploy` fails with
**P3005**; `deploy.sh` detects that, runs `migrate resolve --applied 0_init` once, then
re-deploys. No-op on every subsequent deploy and on a fresh DB.

## Incident playbook

- **Site down after deploy** — `docker compose ps` / `docker compose logs app`. App won't
  start if the boot env check fails (missing `NEXT_PUBLIC_PRIVY_APP_ID` /
  `PRIVY_APP_SECRET` / `DATABASE_URL` → throws, see `src/instrumentation.ts`). If the new
  image is bad, roll back (above).
- **Poller wedged** — heartbeat healthcheck restarts it automatically when the heartbeat
  goes stale (>180s). If it keeps flapping: `docker compose logs poller`.
- **Bets stuck "Awaiting resolution"** — `fetchResolution` must query `closed=true`
  (Gamma hides closed markets); a regression there leaves bets unsettled. Check the canary
  (below) and `src/lib/polymarket.ts`. Re-run settlement: `docker compose logs poller`,
  and `npm run settle` if a manual pass is needed.
- **CI deploy job fails in ~2s** — almost always **Actions billing/minutes on the
  PERSONAL account**. Set a spending limit / enable GitHub Pro. A Team org does **not**
  cover a personal repo — billing follows the account that owns the repo.
- **SSH lockout** — recover via the provider's **rescue mode**, or the **VNC console**
  (root + password) as fallback; re-enable/repair `ssh.service`, then re-add the CI key.
  Full path: see team memory (rescue runbook).
- **DB concerns** — backups are currently **manual / VPS-level** only (no scheduled
  job). **Gap — flag this.** Take an ad-hoc dump before risky migrations:
  `docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`.

## Required env (`/opt/hedgefun/.env`)

- `DATABASE_URL` — Postgres connection (internal `db` service).
- `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` — auth (hard-required at boot).
- `REFERRAL_HASH_SECRET` — referral device anti-fraud + cross-browser attribution.
  Soft: unset → those guards become no-ops and `src/instrumentation.ts` warns at boot.
- `GHCR_USER`, `GHCR_TOKEN` — GHCR login for `docker compose pull` (token = read:packages PAT).
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` — Postgres container init.

`NEXT_PUBLIC_PRIVY_APP_ID` is also a GH secret (baked into the image at build time).

## Canary

`.github/workflows/canary.yml` runs `npm run verify:polymarket` daily (09:00 UTC). It
exercises the live Polymarket Gamma integration (deck fetch, `closed=true` resolution
lookup, market mapping). **Red = Polymarket API drifted** — settlement/deck can silently
break (the "stuck in Awaiting resolution" class). Investigate `src/lib/polymarket.ts`
before the next deploy.
