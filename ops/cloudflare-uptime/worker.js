// Cloudflare Worker — external uptime probe + last-resort reboot lever for the
// HedgeFun VPS. Zero dependencies. Deploy: see wrangler.toml + README.md.
//
// Signal separation (docs/ops-monitoring-plan.md §1): only a NETWORK-LEVEL failure
// (fetch throw: timeout / connection refused / DNS) counts toward "host down" and may
// authorize a reboot. Any HTTP response — 503 included — proves the VM answered and is
// "host alive". The app being unhealthy is "degraded": alert only, never reboot.
//
// State lives in KV as ISO timestamps (KV is eventually consistent — timestamps, not
// counters). Keys: downSince, degradedSince, lastAlertAt, lastRebootAt.

const HEALTH_URL_DEFAULT = "https://app.hedgeyour.fun/api/health";
const PROBE_TIMEOUT_MS = 10_000;
const TG_TIMEOUT_MS = 5_000;
const DOWN_ALERT_AFTER_MS = 9 * 60_000; // ≥2 probes at the 5-min cron
const ALERT_COOLDOWN_MS = 30 * 60_000;
const REBOOT_AFTER_MS = 10 * 60_000;
const REBOOT_LATCH_MS = 6 * 60 * 60_000; // never a second reboot inside 6 h

const worker = {
  async scheduled(event, env) {
    try {
      await tick(env);
    } catch (err) {
      // A failing tick must never wedge the cron. If KV reads fail we cannot trust
      // the reboot latch, so we bail safely: no hc.io ping this run → the worker's
      // own dead-man check fires.
      await tg(env, `⚠️ CF uptime worker tick failed: ${err && err.message ? err.message : err}`);
    }
  },
};
export default worker;

async function tick(env) {
  const healthUrl = env.HEALTH_URL || HEALTH_URL_DEFAULT;
  let probe;
  try {
    probe = await fetch(healthUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    probe = null; // network-level failure → host-down candidate
  }

  const now = Date.now();
  const state = await getState(env);
  const downSince = toMs(state.downSince);
  const degradedSince = toMs(state.degradedSince);
  const lastAlertAt = toMs(state.lastAlertAt);
  const lastRebootAt = toMs(state.lastRebootAt);

  if (probe && probe.status === 200) {
    // Recovery — clear any outstanding outage state.
    if (downSince || degradedSince) {
      await env.STATE.delete("downSince").catch(() => {});
      await env.STATE.delete("degradedSince").catch(() => {});
      const since = downSince ? iso(downSince) : "unknown";
      await tg(env, `✅ app.hedgeyour.fun recovered (was down since ${since})`);
    }
    await ping(env);
    return;
  }

  if (probe) {
    // Degraded: HTTP non-200 → VM answered, NOT a reboot trigger. A stale downSince
    // means the host came back but the app didn't — reset the down clock.
    if (downSince) {
      await env.STATE.delete("downSince").catch(() => {});
    }
    const fresh = !degradedSince;
    if (fresh) {
      await env.STATE.put("degradedSince", iso(now));
    }
    if (fresh || !lastAlertAt || now - lastAlertAt > ALERT_COOLDOWN_MS) {
      await env.STATE.put("lastAlertAt", iso(now));
      await tg(env, `⚠️ /api/health returned ${probe.status} since ${iso(degradedSince || now)} — VM alive, NOT rebooting`);
    }
    await ping(env);
    return;
  }

  // Host down (fetch threw: timeout / refused / DNS).
  if (!downSince) {
    await env.STATE.put("downSince", iso(now));
  }
  const downForMs = now - (downSince || now);
  if (downForMs >= DOWN_ALERT_AFTER_MS && (!lastAlertAt || now - lastAlertAt > ALERT_COOLDOWN_MS)) {
    await env.STATE.put("lastAlertAt", iso(now));
    await tg(env, `🚨 app.hedgeyour.fun unreachable at network level since ${iso(downSince || now)} — ${leverStatus(env)}`);
  }
  if (env.AUTO_REBOOT === "true" && downForMs >= REBOOT_AFTER_MS &&
      (!lastRebootAt || now - lastRebootAt >= REBOOT_LATCH_MS)) {
    await maybeReboot(env);
  }
  await ping(env);
}

// Whether the lever can actually fire belongs in the outage alert itself: reading
// "unreachable at network level", the on-call has to know in that first message whether to
// wait for the automation or go open the panel. On 2026-09-08 nothing was armed and nothing
// said so.
function leverStatus(env) {
  if (env.AUTO_REBOOT !== "true") return `auto-reboot DISARMED (AUTO_REBOOT=${env.AUTO_REBOOT ?? "unset"}) — power-cycle it yourself`;
  if (!env.CONTABO_INSTANCE_ID) return "auto-reboot armed but CONTABO_INSTANCE_ID is unset — it will NOT fire";
  return `auto-reboot armed, fires at ${REBOOT_AFTER_MS / 60_000} min down`;
}

// States that mean a deliberate operation is under way: power-cycling then destroys work
// someone started. Every OTHER state — including "unknown", "error" and a state we could
// not read — is a reason to try, because the host has already been dark for REBOOT_AFTER_MS.
// This used to demand exactly "running"; on 2026-09-08 Contabo reported "Unknown" for 14 h,
// which is precisely the case the lever exists for, and it stood down.
const DO_NOT_POWER_CYCLE = new Set([
  "stopped", "installing", "provisioning", "manual_provisioning",
  "rescue", "reset_password", "uninstalled",
]);

// Reboot lever. All gates are checked by the caller; here we only stand down for a
// deliberate operation, latch FIRST, then request the restart. A KV write failure aborts
// the reboot — the latch is what prevents a double restart, so it must land before the action.
async function maybeReboot(env) {
  const instanceId = env.CONTABO_INSTANCE_ID;
  if (!instanceId) {
    await tg(env, "⚠️ AUTO_REBOOT is armed but CONTABO_INSTANCE_ID is unset — the lever cannot fire");
    return;
  }
  try {
    const token = await contaboToken(env);
    const status = await instanceStatus(env, token, instanceId);
    if (DO_NOT_POWER_CYCLE.has(String(status || "").toLowerCase())) {
      await tg(env, `Contabo: instance state is "${status}" — a deliberate operation is under way, not power-cycling`);
      return;
    }
    try {
      await env.STATE.put("lastRebootAt", iso(Date.now())); // latch BEFORE action
    } catch (err) {
      await tg(env, `KV error: latch write failed, reboot ABORTED (${err && err.message ? err.message : err})`);
      return;
    }
    const actStatus = await requestRestart(env, token, instanceId);
    await tg(env, `⚡ AUTO_REBOOT: Contabo restart requested (${actStatus} = accepted, not recovered)`);
  } catch (err) {
    await tg(env, `Contabo API error: ${err && err.message ? err.message : err}`);
  }
}

async function contaboToken(env) {
  const res = await fetch("https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: env.CONTABO_CLIENT_ID,
      client_secret: env.CONTABO_CLIENT_SECRET,
      username: env.CONTABO_API_USER,
      password: env.CONTABO_API_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function instanceStatus(env, token, instanceId) {
  const res = await fetch(`https://api.contabo.com/v1/compute/instances/${instanceId}`, {
    headers: { Authorization: `Bearer ${token}`, "x-request-id": crypto.randomUUID() },
  });
  if (!res.ok) throw new Error(`instance state check HTTP ${res.status}`);
  const body = await res.json();
  const instance = Array.isArray(body.data) ? body.data[0] : body;
  return instance && instance.status;
}

async function requestRestart(env, token, instanceId) {
  const res = await fetch(`https://api.contabo.com/v1/compute/instances/${instanceId}/actions/restart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-request-id": crypto.randomUUID() },
  });
  return res.status;
}

async function tg(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
  } catch {
    // alerting must never break the tick
  }
}

// The worker's own dead-man: pinged at the end of every successful scheduled run.
async function ping(env) {
  if (!env.HC_PING_URL) return;
  try {
    await fetch(env.HC_PING_URL, { signal: AbortSignal.timeout(5_000) });
  } catch {}
}

async function getState(env) {
  const keys = ["downSince", "degradedSince", "lastAlertAt", "lastRebootAt"];
  const out = {};
  for (const key of keys) {
    const v = await env.STATE.get(key);
    if (v !== null) out[key] = v;
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString();
const toMs = (v) => (typeof v === "string" ? Date.parse(v) : null);
