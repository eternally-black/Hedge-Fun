// DB-free, network-free self-check for the CLOB client layer (D10/A3). The global fetch is stubbed
// with fixtures; timers are real (the micro-batch window is 15ms, the cache TTL is 3s — the test
// pays one real TTL wait to prove stale-serving). Run: npx tsx scripts/test-clob.ts
//
// The module-level cache survives across cases in this process, so each case uses its OWN token ids.
import assert from "node:assert";
import { getBook, getBooks, ClobUnavailableError } from "../src/lib/clob";
import { BOOK_CACHE_TTL_MS } from "../src/lib/config";

// A /books response entry, shaped like the live API (levels as decimal STRINGS).
function bookPayload(assetId: string, asks: [string, string][], bids: [string, string][] = [["0.48", "10"]]) {
  return {
    market: "0xmarket",
    asset_id: assetId,
    hash: "0xhash",
    timestamp: "1784000000",
    min_order_size: "5",
    tick_size: "0.01",
    neg_risk: false,
    asks: asks.map(([price, size]) => ({ price, size })),
    bids: bids.map(([price, size]) => ({ price, size })),
  };
}

// Install a fetch stub; returns the call counter. Restore with the returned cleanup.
function stubFetch(handler: (url: string, body: { token_id: string }[]) => Promise<unknown[]>) {
  const orig = globalThis.fetch;
  const calls: { token_id: string }[][] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "[]")) as { token_id: string }[];
    calls.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => handler(String(url), body),
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

function stubFetchFailure(status = 500) {
  const orig = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async () => {
    count++;
    return { ok: false, status, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { count: () => count, restore: () => (globalThis.fetch = orig) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ─── 1. asset_id matching: a deliberately SHUFFLED response still gives every token its own book ──
  {
    const stub = stubFetch(async (_url, body) => {
      const books = body.map(({ token_id }) =>
        bookPayload(token_id, [[token_id.endsWith("1") ? "0.51" : "0.52", "100"]]),
      );
      return books.reverse(); // upstream order is NOT request order (verified live)
    });
    const ids = ["m1-tok1", "m1-tok2", "m1-tok3"];
    const books = await getBooks(ids);
    for (const id of ids) {
      const b = books.get(id);
      assert.ok(b, `book present for ${id}`);
      assert.strictEqual(b!.tokenId, id, "matched by asset_id, never by position");
      assert.strictEqual(b!.asks[0]!.priceBp, id.endsWith("1") ? 5100 : 5200, "the book's OWN ladder, not a neighbour's");
      assert.strictEqual(b!.minOrderSize, 5, "min_order_size parsed");
      assert.strictEqual(b!.tickSize, 0.01, "tick_size parsed");
    }
    stub.restore();
    console.log("✓ 1. asset_id matching under a shuffled response");
  }

  // ─── 2. micro-batch coalescing: N concurrent asks for overlapping sets -> ONE upstream call ──────
  {
    const stub = stubFetch(async (_url, body) => body.map(({ token_id }) => bookPayload(token_id, [["0.52", "100"]])));
    // Fired synchronously, so all three land in the SAME 15ms flush window (with an overlap on tok1).
    const [one, map, three] = await Promise.all([
      getBook("m2-tok1"),
      getBooks(["m2-tok1", "m2-tok2"]),
      getBook("m2-tok3"),
    ]);
    assert.strictEqual(stub.calls.length, 1, `overlapping concurrent misses coalesced into ONE /books call (got ${stub.calls.length})`);
    assert.deepStrictEqual(
      [...stub.calls[0]!.map((b) => b.token_id)].sort(),
      ["m2-tok1", "m2-tok2", "m2-tok3"],
      "the single call fetched the UNION of the misses",
    );
    assert.strictEqual(one, map.get("m2-tok1"), "both waiters for the same token share one book");
    assert.ok(three && map.get("m2-tok2"), "all waiters resolved");
    // A repeat call inside the TTL never touches the network.
    await getBook("m2-tok1");
    assert.strictEqual(stub.calls.length, 1, "TTL cache hit -> no refetch");
    stub.restore();
    console.log("✓ 2. micro-batch coalescing (one union call) + TTL hit");
  }

  // ─── 3. negative caching: a known-dead token is not re-fetched on every poll ─────────────────────
  {
    const stub = stubFetch(async (_url, body) =>
      // tok2 absent from the response entirely; tok3 present but both sides empty.
      body.flatMap(({ token_id }) => {
        if (token_id === "m3-tok2") return [];
        if (token_id === "m3-tok3") return [bookPayload(token_id, [], [])];
        return [bookPayload(token_id, [["0.52", "100"]])];
      }),
    );
    const first = await getBooks(["m3-tok1", "m3-tok2", "m3-tok3"]);
    assert.ok(first.get("m3-tok1"), "live token has a book");
    assert.strictEqual(first.get("m3-tok2"), null, "absent token -> null (negative cache)");
    assert.strictEqual(first.get("m3-tok3"), null, "empty book -> null (negative cache)");
    const callsAfterFirst = stub.calls.length;
    const second = await getBooks(["m3-tok2", "m3-tok3"]);
    assert.strictEqual(second.get("m3-tok2"), null, "still null within the TTL");
    assert.strictEqual(stub.calls.length, callsAfterFirst, "negative cache hit -> NO refetch inside the TTL");
    stub.restore();
    console.log("✓ 3. negative caching of absent/empty books");
  }

  // ─── 4. stale-serving with an HONEST fetchedAtMs on upstream failure ─────────────────────────────
  {
    const ok = stubFetch(async (_url, body) => body.map(({ token_id }) => bookPayload(token_id, [["0.52", "100"]])));
    const fresh = await getBook("m4-tok1");
    assert.ok(fresh, "initial fetch succeeds");
    ok.restore();

    // Let the TTL lapse, then fail every attempt (500s -> retries with bounded backoff).
    await sleep(BOOK_CACHE_TTL_MS + 200);
    const down = stubFetchFailure(500);
    const stale = await getBook("m4-tok1");
    assert.ok(stale, "last good book is served when the CLOB is down");
    assert.strictEqual(stale!.fetchedAtMs, fresh!.fetchedAtMs, "fetchedAtMs stays HONEST — the cache never launders staleness");
    assert.ok(down.count() > 1, "failure was retried with backoff before degrading");
    assert.ok(Date.now() - stale!.fetchedAtMs > BOOK_CACHE_TTL_MS, "the served book really is stale (callers enforce freshness)");
    down.restore();
    console.log("✓ 4. stale-serving on upstream failure with honest fetchedAtMs");
  }

  // ─── 5. upstream down + NO last good -> typed ClobUnavailableError (routes map it to a 502) ──────
  {
    const down = stubFetchFailure(503);
    await assert.rejects(
      getBook("m5-never-seen"),
      (e: unknown) => e instanceof ClobUnavailableError,
      "no book to degrade to -> ClobUnavailableError",
    );
    down.restore();
    console.log("✓ 5. ClobUnavailableError when nothing can be served");
  }

  console.log("\nclob client: OK");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
