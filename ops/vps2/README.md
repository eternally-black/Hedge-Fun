# VPS2 — the monitoring host

Everything that must survive VPS1 dying lives here: **GlitchTip** (error tracking),
**Uptime Kuma** (uptime checks, push dead-men, Telegram), **tg-bridge**, the
**uptime-guard** (network-level probe of VPS1 + the Contabo reboot lever), and
**backup-pull** (append-only offsite copies of VPS1's dumps). Rationale: a monitor on the
same host it monitors is blind exactly when that host dies — this host is the fix.

## Install

```bash
scp -r ops root@<vps2>:/root/hedgefun-ops
ssh root@<vps2> bash /root/hedgefun-ops/vps2/install-vps2.sh
```

Idempotent; re-run after changing anything under `ops/vps2/` (app deploys never touch
this host). Then follow the printed next steps. Layout on the host:

- `/opt/glitchtip` — the compose stack (caddy + glitchtip + valkey + postgres + tg-bridge
  + kuma). Dir name = compose project name the shared watchdog expects.
- `/opt/ops` — `notify.sh`, the watchdog (same script as VPS1, repointed via unit env),
  `uptime-guard.sh`, `backup-pull.sh`, and `.env` (from `ops-env.example`).
- `/opt/backups/hedgefun` — pulled dumps; `/var/lib/hedgefun` — watchdog/guard state.

## Kuma monitors to create

The UI is **not** on the public internet: Kuma has no admin until someone creates one, so
the first visitor to `push.hedgeyour.fun` would have owned this host. Caddy publishes only
`/api/push/*` (the dead-man endpoint VPS1 pings); everything else answers 403. Reach the UI
through the loopback publish instead:

```bash
ssh -L 3001:127.0.0.1:3001 root@<vps2>   # then open http://127.0.0.1:3001
```


1. HTTP `https://app.hedgeyour.fun/api/health` — 60 s interval, alert on non-200.
2. **Push** monitors (dead-men) for: poller (grace 5 min), VPS1 backup (grace 6 h),
   VPS1 watchdog (grace 10 min), uptime-guard (grace 10 min), backup-pull (grace 26 h).
   Paste each `/api/push/<token>` URL into the matching env var:
   VPS1 `/opt/hedgefun/.env` → `POLLER_HC_URL`, `BACKUP_HC_URL`, `WATCHDOG_HC_URL`;
   VPS2 `/opt/ops/.env` → `GUARD_HC_URL`, `BACKUP_PULL_HC_URL`.
3. Telegram notification channel (bot token + chat id), attached to every monitor.

**Who watches the watcher:** point one free UptimeRobot monitor (Telegram + email) at
`https://ingest.hedgeyour.fun` — VPS2's only public 200, and if VPS2 dies that is the
alert that still fires. (`push.hedgeyour.fun` answers 403 by design now, so it is not a
usable monitor target.) The optional CF worker (`ops/cloudflare-uptime/`) is a third,
Cloudflare-hosted layer.

## The reboot lever (uptime-guard)

Every 2 min VPS2 probes `/api/health` on VPS1. **Any HTTP response — 503 included —
counts as host ALIVE** (an app/db/Caddy failure must never power-cycle a healthy VM);
only network-level failure counts as down. Alert at ~4 min. With `AUTO_REBOOT=1` in
`/opt/ops/.env`, after **10 min** of network-down AND the Contabo API confirming the
instance is `running`, it requests one restart — then latches for **6 h**.

Keep `AUTO_REBOOT=0` until a staged drill passes: with the owner watching, stop caddy on
VPS1 (`docker stop hedgefun-caddy-1`) → expect *degraded/alert only*; then firewall-drop
the probe or stop the VM from the panel → expect the down alert, and (armed) exactly one
restart request. Restore everything after.

## Backup pull

Nightly 04:15 rsync of `/opt/hedgefun/backups/` (after VPS1's 03:30 dump), `--ignore-existing`
(append-only), sha256-verified, 28-day retention here. Uses the dedicated read-only key
`/root/.ssh/backup_pull`; install the restricted `authorized_keys` line printed by the
installer on VPS1 — a compromised VPS1 cannot reach these copies, and this host's key
cannot write VPS1. Once verified (`bash /opt/ops/ops/backup-pull.sh` by hand), set
`BACKUP_OFFSITE_PULL=1` in VPS1's `/opt/hedgefun/.env` to silence its nightly
"no offsite" WARN. rclone→R2 on VPS1 remains an optional second offsite leg.

## Expendable by design (documented, not backed up)

GlitchTip events (30-day retention diagnostics) and Kuma's monitor config are
re-creatable; only VPS1's Postgres dumps are treated as irreplaceable. If you want Kuma
config to survive VPS2 loss, snapshot `/opt/glitchtip` volumes occasionally by hand.
