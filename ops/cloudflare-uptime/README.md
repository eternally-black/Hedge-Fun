# hedgefun-uptime — Cloudflare Worker (OPTIONAL third layer)

Since VPS2 exists, the PRIMARY external probe + reboot lever is `ops/vps2/uptime-guard.sh`
(same rules, runs every 2 min on a host we own). This Worker is the optional
Cloudflare-hosted third layer: it keeps watching even if BOTH VPSes are down, and can act
as the fallback reboot lever. If you deploy both, arm `AUTO_REBOOT` on AT MOST ONE of
them (the guard is the recommended one — shorter cadence).

Cron (`*/5`): probes `https://app.hedgeyour.fun/api/health` from outside the VPS,
alerts on network-level failure, and — only when armed — requests a Contabo restart.

Design source of truth: `docs/ops-monitoring-plan.md` §1, §4, §6.

## What it decides

| Probe result | Meaning | Action |
|---|---|---|
| HTTP 200 | app healthy | clear outage state, ping own hc.io check |
| HTTP non-200 (incl. 503) | **VM alive**, app degraded | alert (≤1/30 min), **never reboot** |
| fetch throw (timeout / refused / DNS) | host down | alert after 2 probes, reboot if armed |

**Never reboot on an HTTP response.** Any response — 503 included — proves the VM
answered. DNS/Caddy/app failures must not power-cycle a healthy VM; only a
network-level failure can authorize a reboot, and only after the Contabo API confirms
the instance still reports `running` (a VM already restarting/stopped is left alone).

Reboot arm switch: `AUTO_REBOOT` (default `false`). When armed, a host-down that lasts
≥10 min triggers one Contabo restart, then a **6 h KV latch** — never a second reboot
inside the window. KV holds timestamps, not counters (KV is eventually consistent).

The worker also pings its own **healthchecks.io dead-man check** at the end of every
successful run — if the worker itself dies or the cron misfires, that check goes silent.

## Deploy

```bash
cd ops/cloudflare-uptime

# 1. Create the KV namespace, paste the returned id into wrangler.toml
npx wrangler kv namespace create STATE

# 2. Set secrets (values never live in this repo)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put HC_PING_URL
npx wrangler secret put CONTABO_CLIENT_ID
npx wrangler secret put CONTABO_CLIENT_SECRET
npx wrangler secret put CONTABO_API_USER
npx wrangler secret put CONTABO_API_PASSWORD

# 3. Confirm the plan says the Contabo instance id, set the var:
#    [vars] CONTABO_INSTANCE_ID = "<instance-id>"   (keep AUTO_REBOOT = "false")

# 4. Deploy
npx wrangler deploy
```

Contabo API credentials: **Contabo Customer Panel → Settings → API** — the client id,
secret, and API user/password are created there. The instance id is on the instance's
detail page.

## Staged rollout for AUTO_REBOOT

1. **Keep `AUTO_REBOOT = "false"` for the first week.** The worker still probes, alerts,
   and maintains KV state — only the reboot lever is off.
2. Watch for false positives (none expected, but the drill is what proves it).
3. Run a **staged failure drill**: stop the app stack, watch the alert fire at ≥9 min,
   then confirm no reboot happens while `AUTO_REBOOT=false`.
4. Only after the drill passes, flip `AUTO_REBOOT = "true"` and set
   `CONTABO_INSTANCE_ID`. The 6 h latch and the running-state check stay in force.

## State keys (KV `STATE`)

`downSince`, `degradedSince`, `lastAlertAt`, `lastRebootAt` — ISO timestamps. Absent
key = no incident. Timestamps, not counters: two later probes reconcile against
`downSince` directly, so an eventually-consistent KV read can't double-count.
