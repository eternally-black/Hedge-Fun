# HedgeFun Ops: Monitoring, Alerting & Self-Healing — Implementation Plan

Status: **v4 FINAL** — v3 was reviewed by GPT Sol 5.6 and Kimi K3 (2026-08-13, corrections
attributed inline); v4 adds the owner's second VPS revealed mid-execution. Owner requirement:
real-money alpha is imminent; the system must survive unattended nights — every failure is
either healed automatically or alerts the owner's personal Telegram bot immediately.
Free / open-source tools only. Execution: DeepSeek v4 flash (Claude Code CLI) wrote the [DS]
files from per-slice packets; root (Fable) hand-wrote the [ROOT] host-mutating files,
line-reviewed everything, and committed slice by slice.

## v4 delta — VPS2, the monitoring host (supersedes v3 where they conflict)

The owner has a SECOND VPS. Everything that must survive VPS1 dying moved there
(`ops/vps2/`, its own README): **GlitchTip** (no longer on VPS1 — Sol's same-failure-domain
objection is thereby resolved), **Uptime Kuma** (owner's pick; correct now that it lives on
a different host — HTTP monitors + push dead-men + native Telegram, replacing the
UptimeRobot/healthchecks.io accounts as the primary external layer; they remain optional
backstops), **uptime-guard** (2-min network-level probe of VPS1 + the PRIMARY Contabo
reboot lever — same rules as the CF worker: any HTTP response = alive, 6 h latch,
instance-state check, `AUTO_REBOOT=0` until drilled), and **backup-pull** (append-only
offsite copies over a read-only restricted key — a compromised VPS1 cannot reach them;
`BACKUP_OFFSITE_PULL=1` then silences backup.sh's offsite WARN; rclone→R2 demoted to an
optional second leg). The CF worker (`ops/cloudflare-uptime/`) is kept as an OPTIONAL
third layer. VPS1's Caddy/glitchtip-shared-network ingress bits from v3-S2 were reverted;
the VPS2 stack embeds its own Caddy (glitchtip + kuma subdomains → VPS2's IP).
Watcher-of-the-watcher: one free UptimeRobot monitor on Kuma itself.
Owner checklist: `ops/README.md`. VPS2 runbook: `ops/vps2/README.md`.

## 0. Verified environment facts (audited 2026-08-13 over SSH, read-only)

| Fact | Value |
|---|---|
| VPS | Contabo (84.247.169.158), KVM/QEMU, **12 GB RAM, 6 cores, 193 GB disk (63% used)** |
| OS | Ubuntu 24.04.4 LTS, docker `enabled` at boot |
| Gaps | **no swap; no /etc/docker/daemon.json (unbounded container logs); `kernel.panic_on_oops=0`; no DB backups; no external monitoring; no error tracking** |
| Already OK | `kernel.panic=10`; all 4 containers healthy; memory limits in compose (except caddy) |
| Latent bug | compose comments claim unhealthy → restart; **plain Docker never restarts on a failing healthcheck** (Swarm-only), and `docker compose up -d <svc>` is a **no-op** for a running-but-unhealthy container (both advisors) — the fix must be an explicit `docker restart` |
| Domain | `app.hedgeyour.fun` → Caddy (auto-TLS), sole ingress |
| Repo | private → GH Actions minutes limited; **no new cron workflows** |
| Deploy | push to `main` → GH Actions → GHCR → ssh `bash deploy.sh` (root; `git reset --hard origin/main` syncs infra files). Pull/migrate failure leaves the old stack running (fails safe) |
| Next.js | 16.2.9; `onRequestError` hook available; `src/middleware.ts` runs on the **edge** runtime (Sentry must not statically import into it) |
| Poller | 60 s tick; heartbeat written only after a completed loop pass; esbuild-bundled to `dist/poller.cjs`; the runtime image ships **without** general node_modules for it (Prisma only) — bundling `@sentry/node` is a risk we avoid entirely (see S3) |
| App image | runs as UID 1001 — root-owned named volumes are not writable by it (Sol); we avoid needing one |
| GlitchTip hosted free tier | 1,000 events/month — a smoke-test quota (K3); self-hosting chosen (owner preference + quota), with Sol's containment measures |

## 1. Architecture — defense in depth

No single point of alerting: Telegram is primary via three independent senders (own bot from
VPS + CF Worker, UptimeRobot native TG, healthchecks.io native TG), with **email backstops**
enabled on UptimeRobot + healthchecks.io and a local append-only alert log on the VPS.

```
 L3 OUTSIDE the VPS           L2/L4 ON the VPS (host)       L1/L5 IN the stacks
 ─────────────────            ───────────────────────       ─────────────────────
 UptimeRobot ──HTTP──▶ /api/health (app+db only) ◀── app ◀─┐
 CF Worker ───HTTP──▶      │                               ├─ SENTRY_DSN ─▶ GlitchTip
   │ └─(host UNREACHABLE    │                              │   (/opt/glitchtip,
   │    ≥10m + Contabo      watchdog.timer (2 min,         poller (envelope    │ alert
   │    state check)→reboot  both compose projects)         helper) ───────────┘ webhook
   └───TG alert                                                        tg-bridge ─▶ TG
 healthchecks.io ◀─ pings: poller tick · backup · watchdog · canary · CF worker
```

Separation of signals (Sol): **VM liveness** (network-level reachability — the only thing that
may authorize a reboot) ≠ **app readiness** (`/api/health`: app+db) ≠ **poller business
health** (its own alerts: consecutive subsystem failures, settlement backlog age). A 503 from
`/api/health` proves the VM answered — the Worker never reboots on it.

### Self-healing chain for "VPS died at night"

1. Kernel panic → `kernel.panic=10` (+ new `panic_on_oops=1`) reboots; docker `enabled` +
   `restart: unless-stopped` restore both stacks; boot notifier → TG "VPS rebooted".
2. Container wedge (unhealthy) → watchdog `docker restart`s it within 2 min (flap-guarded,
   DB max 1 attempt), deduped alert + recovery message.
3. dockerd dead → watchdog step 0 `systemctl restart docker`; `live-restore: true` keeps
   containers alive through daemon restarts.
4. VM hung (fetch times out / connection refused at the network level, ≥10 min, AND Contabo
   API reports the instance as running-but-unreachable) → CF Worker: TG alert always; if
   `AUTO_REBOOT=true` (default **false**) → one Contabo restart, then a 6 h timestamped
   KV latch — never a second reboot inside the window, never a reboot on an HTTP 503.
5. Silent stoppage (poller not ticking, backup not running, watchdog dead, canary not
   running, CF worker itself dead) → its healthchecks.io dead-man check fires → TG + email.
6. App up but erroring → GlitchTip alert → tg-bridge → TG; plus poller's direct TG alerts for
   consecutive subsystem failures and settlement backlog.

## 2. Deliverables (file by file)

Authorship: **[ROOT]** = hand-written by root (host-mutating / restart / backup logic — both
advisors insisted). **[DS]** = DS Flash v4 from a packet, root line-reviewed before commit.

### S1 — ops shell layer (`ops/`, `ops/vps/`)

- **[DS]** `ops/notify.sh` — `notify.sh <severity> <message>`; token/chat from env or
  `/opt/hedgefun/.env`; `NOTIFY_DRYRUN=1` prints instead of sending; 10 s curl timeout;
  a failed send **never** returns non-zero; every attempt appended to
  `/var/log/hedgefun-notify.log`.
- **[DS]** `ops/vps/hedgefun-boot-notify.sh` — one TG message on boot.
- **[ROOT]** `ops/vps/hedgefun-watchdog.sh` — every 2 min; `flock` single-instance lock:
  0. `docker info` fails → `systemctl restart docker`, CRIT, exit (next run re-checks).
  1. Reconcile the **declared** service sets (not just `docker ps` output — catches
     missing/dead/paused/restarting, Sol): `/opt/hedgefun`: app poller db caddy;
     `/opt/glitchtip`: web postgres valkey tg-bridge. Running+unhealthy → `docker restart`;
     exited/missing → `docker compose up -d <svc>` in that project; post-restart wait +
     re-check before declaring healed.
  2. Flap guard: ≥3 restarts of one service in 10 min → stop restarting, CRIT "crashloop".
     **db special case: max 1 restart attempt, then alert-only** (a recovering/corrupt
     Postgres must not be power-cycled, Sol).
  3. `WATCHDOG_OBSERVE=1` (initial rollout default in the unit file) → alert-only, no
     restarts; owner flips after burn-in (Sol's staged rollout).
  4. Dedupe via `/var/lib/hedgefun/watchdog.state`: CRIT once on break, re-alert every
     30 min, OK once on heal.
  5. Host checks: disk ≥85% WARN / ≥95% CRIT; available RAM <5% WARN; swap >70% WARN (K3).
  6. Success → GET `$WATCHDOG_HC_URL` (no-op if unset).
- **[ROOT]** `ops/vps/backup.sh` — nightly 03:30 + `predeploy` mode; `set -o pipefail`:
  for **both** databases (hedgefun db, glitchtip postgres — Sol): `pg_dump -Fc` with explicit
  user/db args → temp file → **verify `pg_restore --list` + minimum-size floor** → sha256
  recorded → atomic rename into `/opt/hedgefun/backups/` (mode 600). Retention 7 daily +
  4 weekly. Offsite `rclone copy` to remote `offsite:` (R2; rclone-crypt documented) —
  offsite failure alerts **separately**; missing rclone config → WARN every run (day-one
  checklist item, not optional — both advisors). Success → GET `$BACKUP_HC_URL`; failure →
  CRIT. `predeploy` mode: hedgefun dump only, no retention pass, no hc ping.
- **[ROOT]** `ops/vps/install-ops.sh` — idempotent, run by deploy.sh + manually: sysctls via
  `/etc/sysctl.d/90-hedgefun.conf` (`kernel.panic=10`, `kernel.panic_on_oops=1`,
  `vm.swappiness=10`); 2 G swapfile (fallocate + fstab, `swapon --show` guard, mode 600,
  **skip + WARN if free disk <20 G**, Sol); `/etc/docker/daemon.json` json-file 10m×3 +
  `live-restore: true` — **merge-safe** (fail if an unexpected daemon.json exists),
  `dockerd --validate` before apply, apply only on change (one-time container bounce
  documented); `timedatectl set-ntp true`; install systemd units from the repo checkout,
  `systemctl enable --now` timers; create `/var/lib/hedgefun`, `/opt/hedgefun/backups`.
- **[ROOT]** `ops/vps/systemd/`: `hedgefun-watchdog.{service,timer}` (OnCalendar=*:0/2),
  `hedgefun-boot-notify.service`, `hedgefun-backup.{service,timer}` (03:30,
  Persistent=true).
- **[ROOT]** `deploy.sh` deltas: trap-based TG notify (start/success/failure + failed step);
  **Caddyfile validation gate** before `up`
  (`docker run --rm -v "$PWD/Caddyfile:...:ro" caddy:2-alpine caddy validate`, abort on
  fail — K3's highest-value catch); **pre-migrate backup** (`backup.sh predeploy`, Sol);
  `up -d --wait --wait-timeout 120` so success means **ready**, not just started (Sol);
  `.env` drift warning vs `.env.example` (K3); notify on rollback; invoke `install-ops.sh`
  at the end (before the final `up`, so daemon/log config precedes recreation — Sol's
  ordering point is moot once per-service `logging:` blocks exist, but keep the order sane).

### S2 — GlitchTip stack (`ops/glitchtip/`)

- **[DS]** `docker-compose.yml` — from the official `compose.sample.yml` (2026-08-13):
  `postgres:18` (own volume, real password), `valkey/valkey:9`
  (`--maxmemory 48mb --maxmemory-policy allkeys-lru` — unbounded by default, K3),
  `web` (`glitchtip/glitchtip:6`, `SERVER_ROLE: all_in_one`, `uploads` volume,
  `GLITCHTIP_MAX_EVENT_LIFE_DAYS=30`), `tg-bridge`. **No host port bind. Ingress via a shared
  external docker network `glitchtip-shared`** with alias `glitchtip-web` — Sol killed the
  `host.docker.internal`→loopback route as unreachable-by-design. All `restart:
  unless-stopped`; memory limits web 1g / pg 256m / valkey 64m / bridge 64m; per-service
  `logging:` json-file 10m×3.
- **[DS]** `tg-bridge.mjs` — zero-dep Node http server, internal networks only: GlitchTip
  webhook POST → defensive parse (Slack-style `attachments[].title`/`title_link`, fallback
  raw `text`, unparseable → generic alert with truncated JSON — never drop an alert) → TG
  sendMessage. `--self-test` asserts formatting from a bundled sample payload. Webhook URL
  to configure in GlitchTip is exactly **`http://tg-bridge:8080`** (documented verbatim).
- **[DS]** `env.example` — SECRET_KEY, POSTGRES_PASSWORD, DATABASE_URL, VALKEY_URL,
  `GLITCHTIP_DOMAIN=https://ingest.hedgeyour.fun`, `EMAIL_URL=consolemail://`,
  DEFAULT_FROM_EMAIL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
- **[DS]** `install.sh` — one-shot idempotent: `docker network create glitchtip-shared`
  (if absent), mkdir `/opt/glitchtip`, copy files, generate SECRET_KEY + POSTGRES_PASSWORD
  if missing, chmod 600 .env, `docker compose up -d`, print the `createsuperuser` command.
  README note: re-run install.sh after changing `ops/glitchtip/*` (app deploys don't touch
  this stack); GlitchTip's own PG is in backup.sh scope.

### S3 — app & infra code

Commit order inside the slice: **app code first, compose/Caddy second** (a mid-slice abort
must never leave infra pointing at a route that doesn't exist — both advisors).

- **[DS]** `src/app/api/health/route.ts` — GET → `{ok, db}` only: `SELECT 1` behind a 5 s
  in-memory cache; 200/503; no versions/secrets. **Poller state deliberately excluded**
  (Sol: a reboot-authorizing probe must not fold in poller readiness; poller liveness is
  already triple-covered by its healthcheck, the watchdog, and its hc.io dead-man ping).
- **[DS]** `src/instrumentation.ts` — keep env validation; add Sentry via **dynamic**
  `await import("@sentry/node")` strictly inside the existing `NEXT_RUNTIME === "nodejs"`
  guard (edge middleware must not compile it in — Sol), **init before the required-env
  throw**; export `onRequestError` → no-op on edge; on node, capture with a
  **whitelisted** context: method, routePath, routeType, routerKind — never spread request
  headers/URL query (PII — Sol).
- **[DS]** `src/lib/glitchtip.ts` — **zero-dep Sentry envelope sender** (~50 lines):
  `captureToGlitchTip(err, tags?)` builds a minimal Sentry event envelope and POSTs it to
  the DSN's `/api/<project>/envelope/` endpoint with `AbortSignal.timeout(5000)`, never
  throws, no-op without `SENTRY_DSN`. Used by the poller — this removes the
  esbuild×`@sentry/node`×Dockerfile bundling risk entirely (Sol flagged the image ships no
  node_modules for the poller; both advisors demanded a run-proof otherwise).
- **[DS]** `scripts/poller.ts` — wire `captureToGlitchTip` into: tick-level catch;
  **per-subsystem consecutive-failure counters** (settle pass, deck refresh, hedge-index,
  prune — 3 consecutive failures of one subsystem → one direct TG message + capture; the
  heartbeat alone stays green through swallowed subsystem errors, Sol's key finding);
  **settlement backlog alert**: each tick, cheapest possible query for the oldest bet still
  pending on a market whose `resolutionDeadline` is >6 h past → crossing 0→>0 alerts, then
  hourly re-alert; after each successful tick → fire-and-forget GET `$POLLER_HC_URL`;
  direct TG helper (native fetch, 5 s timeout, never throws).
- **[DS]** `src/lib/polymarket.ts` — add `AbortSignal.timeout(15_000)` to its fetches
  (Sol: an upstream hang currently stalls the whole tick until the 180 s healthcheck kills
  the container — a slow-but-progressing tick must not be killable by one dead socket).
  Thrown timeout = transient, exactly the poller's existing retry contract.
- **[DS]** capture at swallow sites (Sol; minimal set, root-reviewed):
  `src/app/api/swipe/route.ts` (upstream 502 catch + swallowed referral-accrual catch),
  `src/app/api/feed/bet/route.ts` (upstream 502 catch),
  `src/app/api/hedge/suggestions/route.ts` (upstream 502 catch) — `captureException` via
  the dynamically-imported SDK is a safe no-op when Sentry never initialized.
- **[DS]** `docker-compose.yml` (app stack) — fix the false "restart fires on unhealthy"
  comments; caddy: healthcheck `wget -q -O /dev/null http://127.0.0.1:2019/config/`
  (busybox wget, admin API proves process+config — K3), memory limit 128m, join the
  external `glitchtip-shared` network; per-service `logging:` json-file 10m×3 on ALL
  services (daemon.json only affects newly-created containers; db is almost never
  recreated — K3); poller healthcheck: guard against **negative heartbeat age** (clock
  jump, Sol); pass through `SENTRY_DSN`, `TELEGRAM_*`, `POLLER_HC_URL`; declare
  `glitchtip-shared` as external network.
- **[DS]** `Caddyfile` — `ingest.hedgeyour.fun { reverse_proxy glitchtip-web:8000 }`.
- **[DS]** `package.json` — add `@sentry/node` (app only; poller stays SDK-free).

### S4 — external probes & docs

- **[DS]** `ops/cloudflare-uptime/{worker.js,wrangler.toml,README.md}` — cron `*/5`:
  fetch `https://app.hedgeyour.fun/api/health`, 10 s timeout. **Only a network-level
  failure (timeout / connection refused / DNS) counts toward "host down" — any HTTP
  response, including 503, proves the VM answered and never triggers reboot logic** (Sol).
  ≥2 consecutive network failures → TG alert; ≥10 min AND `AUTO_REBOOT=true` (default
  false) AND Contabo API reports the instance not already restarting → one restart
  (OAuth2 password grant at `auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token`;
  `POST api.contabo.com/v1/compute/instances/{id}/actions/restart`, Bearer + UUID4
  `x-request-id`; 201 = accepted, not recovered) → TG; **timestamped KV reboot latch, 6 h
  cooldown** (KV is eventually consistent — timestamps, not counters, Sol+K3); recovery →
  TG OK; every successful cron run pings its own hc.io check (**the worker has its own
  dead-man**, Sol); Contabo call failure alerts separately.
- **[DS]** `.github/workflows/deploy.yml` — replace per-job failure steps with a separate
  **`notify` job, `if: always()`, `needs: [test, build, deploy]`**, that reports whichever
  job failed (a failed upstream job skips dependent jobs, so an in-job step would never
  run — Sol). `canary.yml`: failure notify step + add `npm run verify:clob` + success ping
  to a 4th hc.io check (canary silence must not look healthy — Sol).
- **[DS]** `docs/runbook.md` — "Monitoring & alerting" section (what fires when, where to
  look); backup/restore procedure + **pre-launch restore drill**; secrets inventory for
  total-loss rebuild (both `.env` files — what to recreate, where each value comes from);
  GHCR token rotation; `pg_isready` ≠ corruption coverage; rollback arg format
  (`sha-<short>` exactly as tagged); note that `compose pull` also refreshes mutable base
  tags (pin by digest only if it ever bites — deliberate YAGNI); staged rollout: watchdog
  observe-mode burn-in → enable restarts; AUTO_REBOOT flip only after a staged
  failure drill; first-deploy checklist (Docker-level behaviors untestable locally).
- **[DS]** `ops/README.md` — owner-action checklist (§4), architecture map, env reference,
  post-setup **test-fire of every notification path** (notify.sh, GlitchTip test event,
  UptimeRobot/hc.io test alerts).

## 3. Verification matrix (local machine has NO Docker — stated in every packet)

| Artifact | Check |
|---|---|
| every `*.sh` | `bash -n`; root line-review; notify.sh + watchdog dry-run (`NOTIFY_DRYRUN=1`, stubbed `docker` on PATH) |
| `tg-bridge.mjs`, `worker.js` | `node --check`; `node tg-bridge.mjs --self-test` |
| compose / workflow YAML | `npx --yes js-yaml <file> >/dev/null` (pinned command) |
| TS | `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run build:poller` + **run `node dist/poller.cjs` with a dummy `SENTRY_DSN` and confirm clean startup** |
| systemd units | strict template review by root (no local systemd) |
| Docker/systemd integration | first-deploy checklist in runbook — not locally testable |
| `test:db` suite | impossible locally; runs at merge-to-main CI |

## 4. Owner actions (client-owned accounts/secrets — cannot be automated)

1. **Telegram**: BotFather bot → `TELEGRAM_BOT_TOKEN`; message it once; chat id via
   `getUpdates`. → `/opt/hedgefun/.env`, `/opt/glitchtip/.env`, GH secrets, CF Worker secrets.
2. **DNS**: A record `ingest.hedgeyour.fun` → 84.247.169.158.
3. **GlitchTip**: run printed `createsuperuser`; org+project; DSN → `SENTRY_DSN` in
   `/opt/hedgefun/.env`; alert rule → webhook `http://tg-bridge:8080`.
4. **UptimeRobot** (free): monitors on `/api/health` + glitchtip subdomain; TG **and email**.
5. **healthchecks.io** (free): 5 checks — poller (60 s / grace 5 min), backup (daily /
   grace 6 h), watchdog (2 min / grace 10 min), canary (daily / grace 26 h), CF worker
   (5 min / grace 15 min); URLs → `.env` / worker secret; TG **and email**.
6. **Cloudflare R2** (free 10 GB) + rclone remote `offsite:` (crypt recommended) on the VPS —
   **day-one item**: VM loss or account lock kills DB and local backups together.
7. **CF Worker**: `wrangler deploy`; secrets: TG pair, Contabo client id/secret/user/password
   + instance id, hc.io ping URL. `AUTO_REBOOT=false` until a staged failure drill passes.
8. First deploy: `bash ops/glitchtip/install.sh`; `systemctl list-timers | grep hedgefun`;
   **restore drill once**; test-fire every notification path.

## 5. Execution protocol

- Slices S1→S4; [ROOT] files by root; [DS] files via `ds-exec.sh` packets = shared ground
  rules (`.scratch/ds-preamble.md`) + specs quoted from this doc + repo truths (no local
  Docker; poller esbuild-bundled; middleware is edge; capture-site file list) so the
  executor never meets a contradiction.
- Root verifies per §3, fixes small defects directly, re-dispatches structural ones, then
  commits: `git status` first, explicit `git add <paths>` only — never `-A` (pre-existing
  uncommitted changes must stay uncommitted: `.gitignore`,
  `docs/hedge-fun-phase2-spec.md`, `mobile/App.tsx`).
- Loop until every slice lands green; this plan doc is committed first.

## 6. Failure-mode coverage

| Night failure | Detected by | Healed by | Alerted via |
|---|---|---|---|
| Container crash-loop | watchdog | restart policy; flap guard stops futile cycles | watchdog TG (dedup) |
| Unhealthy-but-running container | watchdog | `docker restart` (observe-mode first) | watchdog TG |
| dockerd dead | watchdog step 0 | `systemctl restart docker` + live-restore | watchdog TG |
| Poller loop dead / not ticking | container healthcheck + hc.io dead-man | watchdog restart | hc.io TG+email |
| Poller green but settlement broken | subsystem counters + backlog-age alert (Sol) | — (needs a human) | poller direct TG + GlitchTip |
| Upstream API hang | 15 s fetch timeouts | poller retry contract | GlitchTip (if persistent) |
| App 5xx storm | GlitchTip + UptimeRobot | restart policy | GlitchTip TG + UptimeRobot TG+email |
| Kernel panic | — | `panic=10`/`panic_on_oops=1` + boot chain | boot-notify TG |
| VM hung / host dead | CF Worker (network-level only) + UptimeRobot | Contabo reboot (flag, 6 h latch, state-checked) | Worker TG + UptimeRobot TG+email |
| Bad Caddyfile shipped | deploy.sh validation gate | deploy aborts, old stack keeps running | deploy TG |
| Deploy "succeeded" but app not ready | `up --wait` gate | deploy fails → rollback | deploy TG |
| Disk filling | watchdog 85/95% | log rotation everywhere + GlitchTip 30 d retention | watchdog TG |
| OOM / memory spike | limits + new swap + swap-use WARN | restart policy; swap absorbs spikes | watchdog TG |
| DB down | healthcheck + watchdog (max 1 restart) | bounded restart; humans for the rest | watchdog TG |
| DB corrupt | pg_dump failure (the real detector) | documented restore + drill | backup TG |
| Backup silent-fail / suspicious | hc.io dead-man + size floor + `pg_restore --list` | — | hc.io + backup TG |
| Offsite copy failing | separate offsite alert | — | backup TG |
| VPS `.env` drift | deploy.sh warning | — | deploy output/TG |
| CI broke / canary silent | notify job `if: always()`; canary hc.io dead-man | — | GH TG + hc.io |
| Polymarket API drift | canary (+ verify:clob now) | — | canary TG |
| GlitchTip stack dead | watchdog (both projects) + UptimeRobot subdomain | watchdog restart | watchdog TG |
| CF Worker itself dead | its hc.io dead-man | — | hc.io TG+email |
| Telegram down / bot revoked | — | — | UptimeRobot + hc.io **email**; local alert log |
| Total VM loss | Worker + UptimeRobot | rebuild: repo + GHCR image + R2 dumps + secrets inventory | Worker/UptimeRobot TG+email |

## 7. Deliberate rejections & deferrals

- Hosted GlitchTip as primary (Sol's preference) — rejected for the 1,000 events/mo quota
  (K3) + owner's explicit self-host choice; Sol's containment adopted instead (limits, own
  backups, external-first for downtime detection).
- Uptime Kuma (owner asked 2026-08-13), autoheal, Watchtower, Prometheus/Grafana/Loki —
  redundant here (both advisors agreed). Kuma specifically: self-hosted on the only VPS it
  would monitor = blind exactly when the VPS dies; UptimeRobot + healthchecks.io + the CF
  Worker already cover its job from OUTSIDE. Revisit only if a second host ever exists
  (then Kuma there is a fine dashboard).
- `@sentry/nextjs`, client-side web SDK, mobile SDK (until Seeker build stabilizes).
- Base-image digest pinning, DNS-integrity monitor, cert-expiry watchdog, WAL/PITR, SMS
  channel — noted in runbook as upgrade paths; not day-one (nightly RPO explicitly accepted
  for alpha; revisit before scale).
