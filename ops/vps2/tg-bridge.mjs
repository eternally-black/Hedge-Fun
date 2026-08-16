#!/usr/bin/env node
// tg-bridge.mjs — forwards GlitchTip Slack-style webhooks to Telegram.
// Zero deps, Node >= 20. Runs inside the compose stack as tg-bridge:8080.
import { createServer } from "node:http";
import assert from "node:assert";

const PORT = Number(process.env.PORT || 8080);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 10000;

// Pull {title, link, text} out of GlitchTip's Slack-style webhook payload.
// Preference: attachments[0], then top-level text, then the raw JSON — an alert
// must never be dropped because the shape changed.
export function extract(body) {
  let title = "";
  let link = "";
  let text = "";
  if (body && typeof body === "object") {
    const att = Array.isArray(body.attachments) ? body.attachments[0] : null;
    if (att && typeof att === "object") {
      if (typeof att.title === "string") title = att.title;
      if (typeof att.title_link === "string") link = att.title_link;
      if (typeof att.text === "string" && att.text) text = att.text;
    }
    if (!text && typeof body.text === "string" && body.text) text = body.text;
  }
  if (!text) {
    try {
      text = JSON.stringify(body).slice(0, 500);
    } catch {
      text = String(body).slice(0, 500);
    }
  }
  return { title, link, text };
}

export function formatAlert(a) {
  return `🐞 GlitchTip: ${a.title}\n${a.link}\n${a.text}`;
}

function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        if (!done) {
          done = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "payload too large" }));
          req.resume(); // drain the rest; the connection closes cleanly once the client finishes
          resolve({ tooLarge: true });
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish({ tooLarge: false, buf: Buffer.concat(chunks) }));
    req.on("error", () => finish({ tooLarge: false, buf: Buffer.alloc(0) }));
  });
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set; alert dropped (logged):", text);
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.error("telegram send failed:", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("telegram send error:", err.message);
  }
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  const { tooLarge, buf } = await readBody(req, res);
  if (tooLarge) return; // 413 already sent by readBody
  let body;
  try {
    body = buf.length ? JSON.parse(buf.toString("utf8")) : {};
  } catch {
    body = { raw: buf.toString("utf8").slice(0, 500) };
  }
  await sendTelegram(formatAlert(extract(body)));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function selfTest() {
  const sample = {
    text: "Resolved: high p95",
    attachments: [
      {
        title: "High CPU on web",
        title_link: "https://ingest.hedgeyour.fun/organizations/ops/issues/42/",
        text: "web has been above 90% CPU for 5 minutes.",
        color: "danger",
      },
    ],
  };
  const msg = formatAlert(extract(sample));
  assert.ok(msg.startsWith("🐞 GlitchTip: "), "missing prefix");
  assert.ok(msg.includes("High CPU on web"), "missing title");
  assert.ok(msg.includes("issues/42/"), "missing link");
  console.log("SELF-TEST OK");
}

if (process.argv[2] === "--self-test") {
  selfTest();
} else {
  createServer(handle).listen(PORT, "0.0.0.0", () => {
    console.log(`tg-bridge listening on 0.0.0.0:${PORT}`);
  });
}
