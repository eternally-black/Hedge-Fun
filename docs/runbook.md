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
  fresher than 180s (3× the 60s tick); stale → the watchdog (`ops/vps/hedgefun-watchdog.sh`)
  restarts the container (Compose never restarts on a healthcheck).
- **migrate** — one-shot `npx prisma migrate deploy`, exits 0. app/poller `depends_on` it
  via `service_completed_successfully`, so they never start against an un-migrated DB.
- **db** — `postgres:16-alpine`, internal-only (no published port), `pgdata` volume.
- **caddy** — `caddy:2-alpine`, ports 80/443, auto-TLS, sole public ingress.

Env comes from a sibling `/opt/hedgefun/.env` (mode 600, not in git).

## Deploy

Push to `main` → `.github/workflows/deploy.yml`:

1. **test gate** — `npm run lint` + `npm test` (DB-free units) + `npm run test:db:run`
   (DB-backed money/economy). Build `needs: test`, so a logic regression can't ship.
2. **build** — build image on the runner, push to GHCR as `:sha-<short>` (the rollback
   handle) plus `:latest` **only when the ref is `main`** — `latest` is the tag `deploy.sh`
   pulls, so a feature-branch build must never move it. `linux/amd64`, `provenance: false`
   (avoids a multi-arch index plain `docker pull`/compose chokes on).
3. **deploy** — gated to `main`; SSHes the VPS and runs `bash deploy.sh`.

What `deploy.sh` does (idempotent):

- `git fetch` + `git reset --hard origin/main` — syncs infra files only (compose /
  Caddyfile / this script); **not** used to build.
- GHCR login (`GHCR_USER` / `GHCR_TOKEN` from `.env`) → `docker compose pull`.
- Brings up `db`, then **baseline-aware `migrate deploy`** (see Schema changes).
- `docker compose up -d --remove-orphans` → `docker image prune -f`.
- Records the live SHA in `.deployed_sha`.

A feature-branch / manual `workflow_dispatch` run only builds + pushes `:sha-<short>` — the
deploy job is hard-gated to `main`, and `latest` (the tag prod pulls) is published from
`main` alone, so such a run cannot reach prod even on the next unrelated deploy.

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

**Hand-written guards:** the partial unique indexes `order_attempts_one_inflight` and
`funding_attempts_one_active`, plus the CHECK constraints `bets_closed_le_filled`,
`bets_paper_no_real_fields`, `bets_real_fields_nonneg`, and `fills_sane`, are **not** in
`schema.prisma` (Prisma cannot model them). After `npm run db:migrate` generates SQL, check
it does not DROP them and re-add them in the generated file if it does —
`scripts/test-schema-guards.ts` fails the DB suite otherwise.

## Incident playbook

- **Site down after deploy** — `docker compose ps` / `docker compose logs app`. App won't
  start if the boot env check fails (missing `NEXT_PUBLIC_PRIVY_APP_ID` /
  `PRIVY_APP_SECRET` / `DATABASE_URL` → throws, see `src/instrumentation.ts`). If the new
  image is bad, roll back (above).
- **Poller wedged** — the watchdog (`ops/vps/hedgefun-watchdog.sh`) restarts it when the
  heartbeat goes stale (>180s). If it keeps flapping: `docker compose logs poller`.
- **Bets stuck "Awaiting resolution"** — `fetchResolution` must query `closed=true`
  (Gamma hides closed markets); a regression there leaves bets unsettled. Check the canary
  (below) and `src/lib/polymarket.ts`. Settlement runs inside every poller tick — force a
  pass with `docker compose restart poller` and watch `docker compose logs -f poller` for
  `[settle]` lines.
- **CI deploy job fails in ~2s** — almost always **Actions billing/minutes on the
  PERSONAL account**. Set a spending limit / enable GitHub Pro. A Team org does **not**
  cover a personal repo — billing follows the account that owns the repo.
- **SSH lockout** — recover via the provider's **rescue mode**, or the **VNC console**
  (root + password) as fallback; re-enable/repair `ssh.service`, then re-add the CI key.
  Full path: see team memory (rescue runbook).
- **DB concerns** — nightly verified dumps at `/opt/hedgefun/backups` (7 daily + 4
  weekly, encrypted, sha256-verified, weekly real-restore drill, offsite by VPS2 pull);
  `deploy.sh` takes a `predeploy` snapshot before migrations automatically. See
  **Backup & restore**.

## Monitoring & alerting

Full design: `docs/ops-monitoring-plan.md`. Telegram is primary; UptimeRobot and
healthchecks.io also send **email** backstops.

What fires when:

- **Watchdog** (`hedgefun-watchdog.service`, every 2 min on the VPS) — container
  crash-loop/unhealthy → `docker restart` (flap-guarded; **DB max 1 attempt** then
  alert-only); dockerd dead → `systemctl restart docker`; disk ≥85/95%, RAM <5% free,
  swap >70% → WARN/CRIT. Observe-mode ships first: alerts without restarting.
- **GlitchTip** (`ingest.hedgeyour.fun`, `SENTRY_DSN`) — app exceptions captured via
  the zero-dep Sentry envelope sender; alerts fan out to Telegram through the `tg-bridge`.
  Hosted on **VPS2** (`ops/vps2/`) — error tracking must not share VPS1's failure domain.
- **Poller direct** — 3 consecutive failures of one subsystem (settle / deck refresh /
  hedge-index / prune) or a settlement backlog >6 h → direct Telegram + GlitchTip.
- **Boot notify** — one Telegram message when the VPS boots (kernel panic / host restart).
- **Deploy notify** — the pipeline's `notify` job pings Telegram on any gate failure;
  `deploy.sh` notifies start/success/failure itself.
- **Externals (VPS2, `ops/vps2/`)** — **Uptime Kuma** holds the HTTP monitor on
  `/api/health` and the push dead-men (poller / backup / watchdog / guard / pull), all
  with native Telegram. Its UI is **not public** (an unclaimed Kuma admin page on the
  internet is a free monitoring host): Caddy proxies only `/api/push/*` and 403s the rest,
  so open the dashboard through `ssh -L 3001:127.0.0.1:3001 root@<vps2>` →
  `http://127.0.0.1:3001`. **uptime-guard** probes VPS1 at network level every 2 min and is
  the PRIMARY reboot lever (Contabo API, 6 h latch, `AUTO_REBOOT=0` until drilled — any
  HTTP response, 503 included, means "alive, don't reboot"). One free UptimeRobot monitor
  watches `ingest.hedgeyour.fun` — VPS2's only public 200 — as the
  watcher-of-the-watcher; the CF worker
  (`ops/cloudflare-uptime/`) is an optional third layer; healthchecks.io is an optional
  substitute for Kuma push monitors.

Staged rollout: the watchdog ships self-healing (`WATCHDOG_OBSERVE=0`); `1` is the opt-in
observe-only mode for a burn-in and must be back at `0` while real money is live.
`AUTO_REBOOT` (VPS2 `/opt/ops/.env`) is armed **last**, only after the staged failure drill
in `ops/vps2/README.md`.

## Backup & restore

Nightly 03:30 `backup.sh` dumps the hedgefun db to `/opt/hedgefun/backups/` (mode 600):
`pg_dump -Fc`, verified with `pg_restore --list` + a minimum-size floor, **encrypted**, then
sha256 recorded next to the final artifact. Retention 7 daily + 4 weekly. **Offsite = VPS2
pulls the dumps at 04:15 over a read-only restricted key** (`ops/vps2/backup-pull.sh`,
append-only, 28-day retention, checksum-verified — a compromised VPS1 cannot touch the
copies; a copy that fails its checksum is quarantined as `*.corrupt` and re-pulled
automatically, instead of being alerted about forever). Set
`BACKUP_OFFSITE_PULL=1` in `/opt/hedgefun/.env` once the pull is verified. rclone
`offsite:` (R2) remains an optional second leg. `deploy.sh` takes a `predeploy` snapshot
before migrations. GlitchTip/Kuma data on VPS2 is documented-expendable (diagnostics).

**Every Sunday the backup also runs a real restore drill**: the finished artifact is
decrypted and restored into a disposable `hedgefun_restore_check` database on the same
Postgres, asserted to contain tables and a non-zero `users` row count, then dropped. A
failed drill is a failed backup — CRIT to Telegram and no dead-man ping. `pg_restore --list`
stays as the cheap nightly gate; it only parses the archive TOC and exits 0 on a dump whose
DATA section is corrupt, which is why the weekly drill exists.

### Encryption (operator step, one time)

Dumps contain user emails, balances and the encrypted CLOB-credential blobs, and they leave
the host every night. Generate a passphrase and put it in `/opt/hedgefun/.env`:

```bash
openssl rand -base64 48          # -> BACKUP_ENC_PASSPHRASE=... in /opt/hedgefun/.env (chmod 600)
```

Store the **only other copy in the password manager**. Never put it on VPS2 or in the
offsite bucket — the copies would then decrypt themselves. Until it is set, `backup.sh`
WARNs to Telegram every night and dumps stay plaintext (it never fails hard on this).
Encrypted dumps are named `<name>.dump.enc`; rotating the passphrase does **not** re-encrypt
old dumps, so keep the previous value until the last dump encrypted with it has aged out.

Restore (drop `openssl enc -d ... |` for a legacy plaintext `.dump`):

```bash
cd /opt/hedgefun/backups
echo "$(cat <dump>.dump.enc.sha256)  <dump>.dump.enc" | sha256sum -c -   # the file holds the bare hash
export BACKUP_ENC_PASSPHRASE='...'                                       # from the password manager
cd /opt/hedgefun
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE \
  -in backups/<dump>.dump.enc \
  | docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --clean --if-exists --exit-on-error
```

`BACKUP_ENC_PASSPHRASE` must be exported in the restoring shell. `--exit-on-error` is not
optional: without it `pg_restore` prints errors, counts them, and still exits 0.

**Pre-launch requirement: run the restore drill once against a throwaway database — an
untested backup is a rumor.** RPO: nightly = up to 24 h loss accepted for alpha; move to
WAL/PITR before scale.

## Secrets inventory (total-loss rebuild)

`/opt/hedgefun/.env` (mode 600, not in git):

- `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` — chosen at setup;
  `POSTGRES_PASSWORD` must match the `db` container's init value.
- `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` — **Privy dashboard** (app id is also a
  GH secret, baked into the image at build time).
- `REFERRAL_HASH_SECRET` — generated locally once.
- `GHCR_USER`, `GHCR_TOKEN` — GitHub username + a **read:packages PAT**. **Rotate
  periodically** (GHCR tokens do not self-expire).
- `SENTRY_DSN` — GlitchTip project DSN (org → project → DSN settings).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — **BotFather** bot + chat id via `getUpdates`.
- `WATCHDOG_HC_URL`, `POLLER_HC_URL`, `BACKUP_HC_URL`, `WATCHDOG_OBSERVE` — healthchecks.io
  ping URLs (created per check) + the observe flag. **Each ping URL is a bearer secret** —
  whoever has one can fake a healthy check and mute its dead-man; that is why every script
  feeds them to `curl` on stdin rather than argv.
- `BACKUP_ENC_PASSPHRASE` — `openssl rand -base64 48`, generated once. **Losing it loses
  every `.dump.enc`**; keep a copy in the password manager, and nowhere on VPS2.

VPS2 `/opt/glitchtip/.env` (generated by `ops/vps2/install-vps2.sh`):

- `SECRET_KEY`, `POSTGRES_PASSWORD` — generated; **restoring the GlitchTip DB requires
  the OLD `POSTGRES_PASSWORD`** — keep a copy off-box.
- `GLITCHTIP_DOMAIN`, `DEFAULT_FROM_EMAIL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

VPS2 `/opt/ops/.env` (see `ops/vps2/ops-env.example`): `TELEGRAM_*`, `GUARD_HEALTH_URL`,
`AUTO_REBOOT`, `CONTABO_CLIENT_ID` / `CONTABO_CLIENT_SECRET` / `CONTABO_API_USER` /
`CONTABO_API_PASSWORD` / `CONTABO_INSTANCE_ID` (**Contabo Customer Panel → Settings →
API**), `GUARD_HC_URL`, `BACKUP_PULL_SOURCE` / `BACKUP_PULL_PORT` / `BACKUP_PULL_HC_URL`,
`WATCHDOG_*`. Plus `/root/.ssh/backup_pull` (re-generate + re-install the restricted
authorized_keys line on VPS1 if lost).

Optional CF worker secrets (third layer): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`HC_PING_URL`, the four `CONTABO_*` values, vars `HEALTH_URL`, `AUTO_REBOOT`,
`CONTABO_INSTANCE_ID` — see `ops/cloudflare-uptime/README.md`.

Notes:

- `pg_isready` only proves the server answers, not that the data is intact — a failed
  `pg_dump` is the real corruption detector (hence the `pg_restore --list` verify, and the
  Sunday restore drill for the DATA section that `--list` never reads).
- Rollback arg is `sha-<short>` exactly as CI tags it: `bash deploy.sh rollback <sha-short>`.
- `docker compose pull` also refreshes mutable base tags (postgres/caddy) — pin by digest
  only if that ever bites.

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

## Real-money console (`/real`) — alpha operating order

The whole real-money surface is one page, `/real`, and it is invisible in the deck by design.
Access needs consent recorded on the account and nothing else — the `REAL_MONEY_EMAILS` /
`REAL_MONEY_TWITTER` allowlist was the alpha gate and has been removed (src/lib/real.ts). The
recovery verbs (close, redeem, withdraw) were already written to survive a flipped allowlist so a
list change could never trap funds; that property costs nothing now and stays.

Order of operations for a fresh account — each step's button stays visible until its state is real:

1. **Enable real money** — records consent. Every money route 403s `consent_required` until it is set.
2. **Provision wallet** — deploys the Deposit Wallet from the DEVICE (one signature), then binds it
   server-side after an on-chain `owner()` check, and pushes the derived CLOB creds to the encrypted
   store. Expect two Privy prompts on a first run: one to derive L2 creds, one for the deploy.
3. **Funding** — copy the bridge address, send USDC, then **Declare deposit** with the dollar amount.
   The status line polls every 20 s; that poll is also what re-arms the server-side watcher, so
   leaving the page kills detection until it is reopened.
4. **Wrap USDC.e → pUSD**, then **Set approvals** (four calls: pUSD to both exchanges, CTF
   `setApprovalForAll` to both). Both ride the relay: the server drives the SDK generator, the device
   signs, the relayer submits.
5. **Order** — pick a market, type the stake (it is the all-in cap, fee included), Buy YES/NO. The
   result line never says "success": a killed attempt says the slot is free, a posted one says the
   reconciler will book it when the trade record lands.
6. **Recovery** — Close (sells the whole remainder), Redeem resolved, Withdraw.

Env this page needs beyond the list above: `POLYMARKET_BUILDER_{API_KEY,SECRET,PASSPHRASE}` (server
only — `/api/builder/sign` signs browser requests with them), `POLYMARKET_BUILDER_CODE` and its
public twin `NEXT_PUBLIC_POLYMARKET_BUILDER_CODE` (attribution tag, signed INTO each order),
`REAL_CREDS_KEY` (AES-256-GCM key for stored CLOB creds), `APP_ORIGIN` (same-origin enforcement),
and `REAL_RECONCILE_URL` + `REAL_RECONCILE_SECRET` for the poller's reconciliation pass.

**If `/api/builder/sign` starts logging `builder sign refused` to GlitchTip**, the SDK is calling a
path outside the allowlist (any GET, plus POST to `/submit`, `/order`, `/orders`, `/auth/api-key`).
Widen it deliberately — that endpoint signs as our builder identity, and `DELETE
/auth/builder-api-key` would revoke the key outright.
