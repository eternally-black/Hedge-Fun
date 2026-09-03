// Polygon RPC failover (src/lib/polygon.ts): the keyed primary, then the keyed fallbacks, then
// publicnode. A transport failure parks an endpoint for a minute and moves on; a JSON-RPC answer is
// final (a revert is not retried elsewhere) — except a refused eth_getLogs RANGE, which retires that
// endpoint for logs only (Alchemy Free caps it at 10 blocks; the watcher scans 9 000). Keys ride in
// the URL path and must never reach a log line. Offline: fetch is stubbed. Part of `npm test`.
import assert from "node:assert/strict";

// Read at module load by polygon.ts — set before the dynamic import below. Keys in the path, on purpose.
process.env.POLYGON_RPC_URL = "http://primary.test/v2/PRIMARY-SECRET";
process.env.POLYGON_RPC_FALLBACK_URLS = " http://second.test/v2/SECOND-SECRET ,, ";

type Mode = "ok" | "http503" | "down" | "logsRange" | "revert";
const mode: Record<string, Mode> = { "primary.test": "ok", "second.test": "ok", "polygon-bor-rpc.publicnode.com": "ok" };
const calls: string[] = []; // "<host> <method>"
const warnings: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
const realWarn = console.warn;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (JSON.parse(String(init?.body)) as { method: string }).method;
  calls.push(`${url.host} ${method}`);
  switch (mode[url.host]) {
    case "http503":
      return new Response("upstream busy", { status: 503 });
    case "down":
      throw new TypeError("fetch failed");
    case "revert":
      return json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
    case "logsRange":
      if (method === "eth_getLogs") {
        return json({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range." } });
      }
    // falls through
    default:
      if (method === "eth_call") return json({ jsonrpc: "2.0", id: 1, result: "0x" + "1".padStart(64, "0") });
      if (method === "eth_getBlockByNumber") return json({ jsonrpc: "2.0", id: 1, result: { number: "0x10" } });
      if (method === "eth_getLogs") return json({ jsonrpc: "2.0", id: 1, result: [] });
      return json({ jsonrpc: "2.0", id: 1, result: "0x0" });
  }
}) as typeof fetch;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};

async function main() {
  const { erc20BalanceOf, erc20IncomingSince, finalizedBlockNumber, PUSD_ADDRESS } = await import("../src/lib/polygon");
  const HOLDER = "0x" + "ab".repeat(20);
  const balance = () => erc20BalanceOf(PUSD_ADDRESS, HOLDER);
  const logs = () => erc20IncomingSince(PUSD_ADDRESS, HOLDER, 80_000_000n, 80_009_000n); // a 9 000-block window
  const take = () => calls.splice(0);

  try {
    // 1. Healthy primary: one call, nothing else touched.
    assert.equal(await balance(), 1n);
    assert.deepEqual(take(), ["primary.test eth_call"], "the primary answers alone");

    // 2. Primary HTTP 503: the second answers; the primary is then parked — the next call skips it.
    mode["primary.test"] = "http503";
    assert.equal(await balance(), 1n);
    assert.deepEqual(take(), ["primary.test eth_call", "second.test eth_call"], "failover to the second on a 503");
    assert.equal(await finalizedBlockNumber(), 16n);
    assert.deepEqual(take(), ["second.test eth_getBlockByNumber"], "a parked primary is not retried for a minute");

    // 3. The second refuses the eth_getLogs range: publicnode takes the logs, the second keeps eth_call.
    mode["second.test"] = "logsRange";
    assert.equal((await logs()).transfers, 0);
    assert.deepEqual(take(), ["second.test eth_getLogs", "polygon-bor-rpc.publicnode.com eth_getLogs"], "a range refusal moves logs on");
    assert.equal((await logs()).transfers, 0);
    assert.deepEqual(take(), ["polygon-bor-rpc.publicnode.com eth_getLogs"], "and that endpoint never sees eth_getLogs again");
    assert.equal(await balance(), 1n);
    assert.deepEqual(take(), ["second.test eth_call"], "while it still serves eth_call");

    // 4. A JSON-RPC answer is final: a revert on the serving endpoint is thrown, not failed over.
    mode["second.test"] = "revert";
    await assert.rejects(balance(), /execution reverted/, "the chain answered — no failover");
    assert.deepEqual(take(), ["second.test eth_call"], "publicnode was not asked to repeat the revert");

    // 5. Everything down: the last transport error surfaces with the module's prefix.
    mode["second.test"] = "down";
    mode["polygon-bor-rpc.publicnode.com"] = "down";
    await assert.rejects(balance(), /polygon rpc/, "an outage is reported as an rpc failure");
    assert.deepEqual(take(), ["second.test eth_call", "polygon-bor-rpc.publicnode.com eth_call"], "every live endpoint was tried once");
    await assert.rejects(balance(), /polygon rpc/);
    assert.deepEqual(take(), [], "all parked: no fetch at all until the cooldown lapses");

    // 6. Keys never reach a log line: warnings name hosts only.
    assert.ok(warnings.length >= 3, `failovers were logged (${warnings.length})`);
    assert.ok(warnings.some((w) => w.includes("primary.test")), "the host is named");
    assert.ok(!warnings.some((w) => /SECRET/.test(w)), "the path (the key) is not");

    console.log("✓ test-polygon-failover: primary → fallback → publicnode, cooldown, logs-range retirement, reverts are final, keys stay out of logs");
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
