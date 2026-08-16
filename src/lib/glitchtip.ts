// Zero-dependency error shipping: Sentry-protocol envelopes to GlitchTip + direct ops Telegram.
// Both fns are async, NEVER throw, resolve void, and no-op when their env var is unset.
// Node-only (global crypto.randomUUID / AbortSignal.timeout — fine on Node 20+); safe to import
// from the edge middleware because they only touch process.env/fetch/crypto INSIDE the call.

export async function captureToGlitchTip(
  err: unknown,
  tags?: Record<string, string>,
): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    console.warn("[glitchtip] invalid SENTRY_DSN, error capture disabled");
    return;
  }
  const publicKey = url.username;
  const projectId = url.pathname.replace(/^\//, "");
  if (!publicKey || !projectId) {
    console.warn("[glitchtip] SENTRY_DSN missing public key or project id, error capture disabled");
    return;
  }

  const eventId = crypto.randomUUID().replace(/-/g, "");
  const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
  const item = JSON.stringify({ type: "event" });
  const payload = JSON.stringify({
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    server_name: process.env.HOSTNAME ?? "hedgefun",
    tags,
    exception: {
      values: [
        {
          type: err instanceof Error ? err.constructor.name : "Error",
          value: err instanceof Error ? err.message : String(err),
        },
      ],
    },
    extra: { stack: err instanceof Error ? (err.stack ?? "") : "" },
  });
  const envelope = `${header}\n${item}\n${payload}\n`;

  try {
    await fetch(`https://${url.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=hedgefun/1.0, sentry_key=${publicKey}`,
      },
      body: envelope,
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn("[glitchtip] envelope send failed", e);
  }
}

export async function sendOpsTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn("[glitchtip] telegram send failed", e);
  }
}
