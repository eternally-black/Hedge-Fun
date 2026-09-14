// DB-free self-check for the browser error channel: the helpers that shape a report (client-report.ts)
// and the route that receives it. Same style as test-csp-report.ts — node:assert, no framework, no DB,
// no network. Run: npx tsx scripts/test-client-report.ts
//
// The case this exists for: 2026-09-13, "Set up trading wallet" failed on the device and the server
// had no record. Each check below is one way that silence could come back.
import assert from "node:assert/strict";
import { PrivyClient } from "@privy-io/server-auth";
import { describeError, failText, reportClientError, reported, step } from "../src/lib/client-report";
import { POST } from "../src/app/api/client-report/route";

(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: "did:privy:report-test" };
  throw new Error("invalid auth token");
};

type Sent = { path: string; body: Record<string, unknown> };
function fakeApi(fail = false) {
  const sent: Sent[] = [];
  const api = async (path: string, init?: RequestInit) => {
    sent.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (fail) throw new Error("report endpoint down");
    return {};
  };
  return { api, sent };
}

const apiError = (status: number, code?: string) =>
  Object.assign(new Error(`/api/x -> ${status}`), { status, body: code ? { error: code } : undefined });

async function main() {
  // 1 — step() tags the stage on the thrown error; the innermost tag wins; values pass through.
  {
    assert.equal(await step("s", async () => 42), 42);
    const inner = await step("outer", () => step("inner", () => Promise.reject(new Error("boom")))).catch((e) => e);
    assert.equal(inner.stage, "inner", "innermost stage is the one kept");
    assert.equal(inner.message, "boom", "the error itself is untouched");
    const frozen = Object.freeze(new Error("frozen"));
    const same = await step("s", () => Promise.reject(frozen)).catch((e) => e);
    assert.equal(same, frozen, "a frozen error is rethrown, not swallowed");
  }

  // 2 — describeError reads our api() shape and any Error; never throws on odd values.
  {
    const d = describeError(Object.assign(apiError(409, "price_moved"), { stage: "intent" }));
    assert.equal(d.status, 409);
    assert.equal(d.code, "price_moved");
    assert.equal(d.stage, "intent");
    assert.equal(d.name, "Error");
    assert.equal(describeError("plain string").message, "plain string");
    assert.equal(describeError(undefined).name, "undefined");
    assert.equal(describeError({ toJSON() { throw new Error("no"); } }).name, "object");
    const long = describeError(new Error("x".repeat(2_000)));
    assert.equal(long.message.length, 500, "message is capped");
    assert.ok((long.stack ?? "").length <= 1_500, "stack is capped");
    const withCause = describeError(new Error("outer", { cause: new Error("inner cause") }));
    assert.match(withCause.message, /outer <- inner cause/);
  }

  // 3 — reported(): a device-side failure is shipped with where + stage and rethrown as the SAME
  //     object; a server error code is NOT shipped (the server already knows); a dead report
  //     endpoint never adds a second failure.
  {
    const { api, sent } = fakeApi();
    const boom = new Error("Wallet proxy not initialized");
    const thrown = await reported(api, "real/provision", () => step("client", () => Promise.reject(boom))).catch((e) => e);
    assert.equal(thrown, boom, "rethrown unchanged");
    await new Promise((r) => setTimeout(r, 0)); // the report is fire-and-forget
    assert.equal(sent.length, 1, "one report");
    assert.equal(sent[0].path, "/api/client-report");
    assert.deepEqual(
      { where: sent[0].body.where, stage: sent[0].body.stage, name: sent[0].body.name, message: sent[0].body.message },
      { where: "real/provision", stage: "client", name: "Error", message: "Wallet proxy not initialized" },
    );

    const quiet = fakeApi();
    await reported(quiet.api, "real/order", () => Promise.reject(apiError(409, "price_moved"))).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(quiet.sent.length, 0, "a server error code is not re-reported");

    const noBody = fakeApi();
    await reported(noBody.api, "real/order", () => Promise.reject(apiError(502))).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(noBody.sent.length, 1, "a 5xx without a JSON body IS reported — that one was invisible too");
    assert.equal(noBody.sent[0].body.status, 502);

    const dead = fakeApi(true);
    await reportClientError(dead.api, "x", new Error("y")); // must resolve, not reject
    assert.equal(await reported(dead.api, "x", async () => "ok"), "ok", "success path is untouched");
  }

  // 4 — failText: a server code stays the code; otherwise stage + words; otherwise the fallback.
  {
    assert.equal(failText(apiError(409, "not_your_wallet"), "Setup failed"), "not_your_wallet");
    const timeout = Object.assign(new Error("Timed out waiting for transaction abc to settle"), { stage: "deploy-wait" });
    assert.equal(
      failText(timeout, "Setup failed"),
      "Setup failed (deploy-wait: Timed out waiting for transaction abc to settle). Try again.",
    );
    assert.equal(failText(new Error(""), "Setup failed"), "Setup failed. Try again.");
    assert.ok(failText(new Error("m".repeat(500)), "Setup failed").length < 170, "the card line is bounded");
  }

  // 5 — the route: identity required, fields capped and whitelisted, one warn line per report,
  //     junk refused, a loop rate-limited.
  {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      const post = (token: string | null, body: string) =>
        POST(new Request("http://localhost/api/client-report", {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body,
        }));
      const valid = JSON.stringify({
        where: "real/provision",
        stage: "client",
        name: "Error",
        message: "Wallet proxy not initialized",
        stack: "Error: Wallet proxy not initialized\n    at x (app.js:1:1)",
        status: 0,
        secret: "must-not-pass-through",
      });

      assert.equal((await post(null, valid)).status, 401, "no bearer -> 401");
      assert.equal((await post("bad", valid)).status, 401, "bad bearer -> 401");
      assert.equal(warns.length, 0, "refused reports leave no line");

      assert.equal((await post("good", valid)).status, 204, "a real report -> 204");
      assert.equal(warns.length, 1, "exactly one log line");
      const line = JSON.parse(warns[0].replace(/^\[client-report\] /, "")) as Record<string, unknown>;
      assert.equal(line.privyId, "did:privy:report-test", "the line names the user");
      assert.equal(line.where, "real/provision");
      assert.equal(line.stage, "client");
      assert.equal(line.message, "Wallet proxy not initialized");
      assert.equal(line.status, "0");
      assert.equal("secret" in line, false, "unknown fields are dropped");

      assert.equal((await post("good", "not json")).status, 400, "junk -> 400");
      assert.equal((await post("good", "[]")).status, 400, "array -> 400");
      assert.equal((await post("good", "{}")).status, 400, "empty report -> 400");
      assert.equal((await post("good", JSON.stringify({ message: "x".repeat(9_000) }))).status, 413, "oversize -> 413");
      const capped = await post("good", JSON.stringify({ message: "m".repeat(2_000) }));
      assert.equal(capped.status, 204);
      const cappedLine = JSON.parse(warns.at(-1)!.replace(/^\[client-report\] /, "")) as { message: string };
      assert.equal(cappedLine.message.length, 500, "message capped server-side too");

      // 10 per minute per user: the ones above count, so the ceiling is reached within this loop.
      let limited = 0;
      for (let i = 0; i < 10; i++) if ((await post("good", valid)).status === 429) limited++;
      assert.ok(limited > 0, "a loop is rate-limited");
      const linesAfter = warns.length;
      assert.equal((await post("good", valid)).status, 429, "still limited");
      assert.equal(warns.length, linesAfter, "a limited report leaves no line");
    } finally {
      console.warn = origWarn;
    }
  }

  console.log("✓ client-report: stages tag, device failures ship, server codes stay quiet, route caps and limits");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
