# Ops — owner-action checklist & layout

Implementation plan: `docs/ops-monitoring-plan.md`. Everything below is the
client-owned, cannot-be-automated setup. Two hosts: **VPS1** (the app,
`/opt/hedgefun`) and **VPS2** (monitoring + offsite backups, `ops/vps2/README.md`).

## What lives where

| Path | Role |
|---|---|
| `ops/notify.sh` | Telegram alert primitive (`notify.sh <INFO\|WARN\|CRIT\|OK> <msg>`), never exits non-zero |
| `ops/vps/` | VPS1 host layer, hand-reviewed: `hedgefun-watchdog.sh` (2-min health+restart, flap-guarded), `backup.sh` (nightly verified dumps + predeploy snapshots), `install-ops.sh` (sysctls/swap/logging/systemd — re-applied by every deploy), `hedgefun-boot-notify.sh`, `systemd/` units |
| `ops/vps2/` | VPS2 monitoring host: GlitchTip + **Uptime Kuma** + tg-bridge stack, `uptime-guard.sh` (network-level probe of VPS1 + the PRIMARY Contabo reboot lever), `backup-pull.sh` (append-only offsite copies), `install-vps2.sh`, own README |
| `ops/cloudflare-uptime/` | OPTIONAL third layer: CF Worker probe + fallback reboot lever (`worker.js`, `wrangler.toml`, README) |

## Owner actions, in order

1. **Telegram** — BotFather bot → `TELEGRAM_BOT_TOKEN`; message it once; chat id via
   `getUpdates`. Goes into: VPS1 `/opt/hedgefun/.env`, VPS2 `/opt/glitchtip/.env` and
   `/opt/ops/.env`, GitHub secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
2. **DNS** — A records `ingest.hedgeyour.fun` and `push.hedgeyour.fun` → **VPS2**.
3. **VPS2 install** — `scp -r ops root@<vps2>:/root/hedgefun-ops && ssh root@<vps2> bash
   /root/hedgefun-ops/vps2/install-vps2.sh`, then follow its printed next steps
   (GlitchTip superuser → `SENTRY_DSN` into VPS1 `.env`; webhook `http://tg-bridge:8080`;
   Kuma admin + monitors **over an SSH tunnel** — the UI is not public, see
   `ops/vps2/README.md`; fill `/opt/ops/.env`; install the printed `backup_pull`
   restricted key line on VPS1). Details: `ops/vps2/README.md`.
4. **Contabo API** (for the reboot lever) — Customer Panel → Settings → API: client id/
   secret + API user/password + the VPS1 instance id → VPS2 `/opt/ops/.env`.
   **`AUTO_REBOOT` stays `0` until the staged drill in `ops/vps2/README.md` passes.**
5. **Kuma push URLs** — paste into VPS1 `/opt/hedgefun/.env` (`POLLER_HC_URL`,
   `BACKUP_HC_URL`, `WATCHDOG_HC_URL`) and VPS2 `/opt/ops/.env` (`GUARD_HC_URL`,
   `BACKUP_PULL_HC_URL`); GH secret `CANARY_HC_URL` for the canary dead-man
   (healthchecks.io works identically if preferred for any of these).
6. **Watcher-of-the-watcher** — one free UptimeRobot monitor on
   `https://ingest.hedgeyour.fun` (VPS2's only public 200 — `push.hedgeyour.fun` serves
   push pings only and 403s everything else) with Telegram **and email** notifications.
7. **First VPS1 deploy after merge** — `deploy.sh` installs timers/sysctls itself; check
   `systemctl list-timers | grep hedgefun`. Once the backup pull is verified by hand, set
   `BACKUP_OFFSITE_PULL=1` in `/opt/hedgefun/.env`. **Run the restore drill once**
   (runbook → Backup & restore).
8. Optional: CF worker (`ops/cloudflare-uptime/README.md`) as a third, Cloudflare-hosted
   probe/lever; rclone `offsite:` → R2 on VPS1 as a second offsite leg.

## Post-setup test-fire (once)

- `bash ops/notify.sh INFO "test from setup"` on each host → lands in Telegram.
- GlitchTip: trigger a deliberate app error → tg-bridge delivers it.
- Kuma: *Send test notification* on each monitor; stop the poller for 6 min → push
  dead-man fires; start it back.
- Watchdog burn-in: the watchdog ships self-healing (`WATCHDOG_OBSERVE=0`); `1` is the
  opt-in observe-only mode for a burn-in and must be back at `0` while real money is live.
- Staged reboot drill (before ever arming `AUTO_REBOOT`): see `ops/vps2/README.md`.
