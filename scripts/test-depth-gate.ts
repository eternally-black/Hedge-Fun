// DB-free, network-free self-check for the depth-eligibility gate (D10/A4–A6 + the Slice-A
// follow-up). Exercises the pure pieces the gate is composed from (evalSideAsks + the shared
// contested band + the TXODDS branch + serve-time servability) on the fixture books that motivated
// the work. The display-quote cases stub global fetch (same idiom as test-clob.ts); timers are real.
// Run: npx tsx scripts/test-depth-gate.ts
import assert from "node:assert";
import { evalSideAsks, slippageCapBpFor, depthGateApplies, authoritativePrices, quoteSideForDisplay } from "../src/lib/depth";
import { priceIsContested } from "../src/lib/polymarket";
import { DEPTH_SLIPPAGE_CAP_BP, BOOK_MAX_DISPLAY_STALE_MS, BOOK_CACHE_TTL_MS } from "../src/lib/config";
import type { BookLevel } from "../src/lib/quote";

const lvl = (priceCents: number, size: number): BookLevel => ({ priceBp: priceCents * 100, size });

// ─── slippageCapBpFor: relative cap with an absolute floor converted for cheap sides ───────────────
{
  assert.strictEqual(slippageCapBpFor(5000), DEPTH_SLIPPAGE_CAP_BP, "mid-price side: the relative cap binds");
  assert.strictEqual(slippageCapBpFor(9800), DEPTH_SLIPPAGE_CAP_BP, "expensive side: floor converts to ~103bp < cap");
  assert.ok(slippageCapBpFor(300) > DEPTH_SLIPPAGE_CAP_BP, "3¢ side: 1¢ of wiggle (3333bp relative) beats the cap");
}

// ─── the husk (bid 1¢ / ask 98¢): fills $10 with zero slippage, so the DEPTH check alone passes it —
//     what kills it is the contested band consuming the EFFECTIVE price (9800bp), not the 49.5¢ mid ──
{
  const yes = evalSideAsks([lvl(98, 50)]); // the husk's YES asks
  assert.strictEqual(yes.tradable, true, "husk fills $10 at 98¢ with no walk -> depth check passes");
  assert.strictEqual(yes.effPriceBp, 9800, "the REAL cost of YES is 98¢, not the 49.5¢ mid");
  assert.strictEqual(yes.maxStakeCents, 4900, "capacity at the cap = the full $49 of depth");
  const no = evalSideAsks([lvl(2, 5000)]); // its NO asks
  assert.strictEqual(no.tradable, true, "NO side fills too");
  assert.strictEqual(no.effPriceBp, 200, "NO costs 2¢");
  assert.strictEqual(
    yes.tradable && no.tradable && priceIsContested(yes.effPriceBp!, no.effPriceBp!),
    false,
    "GATE DROPS THE HUSK: eff 9800 is outside the 1500..8500 band even though the mid was contested",
  );
}

// ─── empty ask side: no quote at all -> dropped ────────────────────────────────────────────────────
{
  const empty = evalSideAsks([]);
  assert.strictEqual(empty.tradable, false, "empty ladder is never tradable");
  assert.strictEqual(empty.effPriceBp, null, "no honest price to store");
  assert.strictEqual(empty.maxStakeCents, 0, "no capacity");
}

// ─── a book that cannot fill $10: dropped even though the top of book prices fine ──────────────────
{
  const thin = evalSideAsks([lvl(38, 5), lvl(45, 1)]); // $2.35 of total depth
  assert.strictEqual(thin.tradable, false, "unfillable stake -> not tradable");
  assert.strictEqual(thin.effPriceBp, null, "a partial fill has no honest 'price for $10'");
}

// ─── a book that fills $10 but slips past the eligibility cap: dropped ─────────────────────────────
{
  // 1 share @ 50¢ then the rest @ 60¢: $10 VWAPs to ~59.4¢ — ~19% relative slippage, past the 5% cap.
  const walky = evalSideAsks([lvl(50, 1), lvl(60, 100)]);
  assert.strictEqual(walky.tradable, false, "filling is not enough when the walk breaches the cap");
  assert.strictEqual(walky.effPriceBp, 5941, "it fills, so the eff price is stored (VWAP, rounded UP)");
  assert.strictEqual(walky.maxStakeCents, 70, "capacity = the 50¢ level + the thin 60¢ slice the ceiling still absorbs");
}

// ─── a healthy two-sided book passes every clause ──────────────────────────────────────────────────
{
  const yes = evalSideAsks([lvl(52, 100), lvl(53, 100)]);
  const no = evalSideAsks([lvl(48, 100)]);
  assert.strictEqual(yes.tradable && no.tradable, true, "deep book fills both sides");
  assert.strictEqual(yes.effPriceBp, 5200, "VWAP at the top level");
  assert.ok(
    priceIsContested(yes.effPriceBp!, no.effPriceBp!),
    "eff prices inside the band -> the card exists",
  );
}

// ─── TXODDS rows are never touched by the depth gate ───────────────────────────────────────────────
{
  assert.strictEqual(depthGateApplies("TXODDS"), false, "TXODDS football has no CLOB book — never gated");
  assert.strictEqual(depthGateApplies("POLYMARKET"), true, "POLYMARKET rows gate on their books");
}

// ─── authoritativePrices: serve-time servability (1a no mid fallback, 1b rejection stamp, 1c bound) ─
const NOW = Date.now();
const FRESH_BOOK = new Date(NOW - 60_000); // 1 min old — far inside the display bound
{
  const row = { yesPriceBp: 4950, noPriceBp: 5050, yesEffPriceBp: 5200, noEffPriceBp: 4900 };
  assert.deepStrictEqual(
    authoritativePrices({ source: "POLYMARKET", ...row, bookTsAt: FRESH_BOOK }, NOW),
    { yes: 5200, no: 4900 },
    "POLYMARKET with a fresh book serves the eff price",
  );

  // 1a + the defect's exact scenario: a husk cached pre-D10 (mid 49.5¢ contested, eff NEVER
  // persisted). The mid used to resurrect it via the fallback; now it is simply NOT SERVABLE.
  const husk = { source: "POLYMARKET", ...row, yesEffPriceBp: null, noEffPriceBp: null, bookTsAt: null };
  const p = authoritativePrices(husk, NOW);
  assert.deepStrictEqual(p, { yes: null, no: null }, "null eff -> NOT servable: no mid fallback for POLYMARKET");
  assert.ok(
    !(p.yes !== null && p.no !== null && priceIsContested(p.yes, p.no)),
    "the husk's contested mid does NOT put it back in the deck (the defect this closes)",
  );

  // 1b: the rejection stamp (evaluated, untradable): eff null + capacity 0 + bookTsAt = verdict time.
  // Distinguishable from "never read" by the non-null bookTsAt, and equally not servable.
  assert.deepStrictEqual(
    authoritativePrices({ source: "POLYMARKET", ...row, yesEffPriceBp: null, noEffPriceBp: null, bookTsAt: FRESH_BOOK }, NOW),
    { yes: null, no: null },
    "rejection-stamped row (fresh bookTsAt, null eff) -> NOT servable",
  );

  // TXODDS: the mid IS the authoritative synthetic price — null eff must NOT drop the row.
  assert.deepStrictEqual(
    authoritativePrices({ source: "TXODDS", ...row, yesEffPriceBp: null, noEffPriceBp: null, bookTsAt: null }, NOW),
    { yes: 4950, no: 5050 },
    "TXODDS with null eff IS servable on its mid (authoritative there, not a fallback)",
  );

  // 1c: eff prices present but the book behind them is older than the DISPLAY bound -> dropped,
  // not shown at a price from a dead book. (Distinct from the 30s LOCK bound — see config.ts.)
  assert.deepStrictEqual(
    authoritativePrices({ source: "POLYMARKET", ...row, bookTsAt: new Date(NOW - BOOK_MAX_DISPLAY_STALE_MS - 1) }, NOW),
    { yes: null, no: null },
    "book read older than BOOK_MAX_DISPLAY_STALE_MS -> NOT servable",
  );
  assert.deepStrictEqual(
    authoritativePrices({ source: "POLYMARKET", ...row, bookTsAt: new Date(NOW - BOOK_MAX_DISPLAY_STALE_MS + 60_000) }, NOW),
    { yes: 5200, no: 4900 },
    "just inside the display bound -> still servable",
  );
}

// ─── quoteSideForDisplay (item 3): the suggestion-card quote path — same book+VWAP as the lock, ────
// ─── display staleness bound, and NEVER a mid. fetch is stubbed; token ids are unique per case  ────
// ─── because clob.ts caches module-level (see test-clob.ts).                                  ────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function stubFetch(handler: (body: { token_id: string }[]) => unknown[]) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "[]")) as { token_id: string }[];
    return { ok: true, status: 200, json: async () => handler(body) };
  }) as unknown as typeof fetch;
  return () => (globalThis.fetch = orig);
}

function stubFetchFailure(status = 500) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status, json: async () => ({}) })) as unknown as typeof fetch;
  return () => (globalThis.fetch = orig);
}

async function main() {
  // The husk, quoted for DISPLAY: $10 of YES costs 98¢ — the price the card must show, not the mid.
  {
    const restore = stubFetch((body) => body.map(({ token_id }) => bookPayload(token_id, [["0.98", "50"]])));
    assert.strictEqual(await quoteSideForDisplay("dq-husk", 1_000), 9800, "husk displays 98¢, never 49.5¢");
    restore();
  }

  // The quote is stake-dependent — the whole point for a variable $1..$500 hedge stake: the same
  // book prices $1 at the top level and $10 walked up the ladder.
  {
    const restore = stubFetch((body) => body.map(({ token_id }) => bookPayload(token_id, [["0.50", "10"], ["0.60", "100"]])));
    // $1 -> 2 shares, all at the 50¢ top level.
    assert.strictEqual(await quoteSideForDisplay("dq-walk", 100), 5000, "$1 fills at the top of book");
    // $10 -> $5 buys the whole 10-share 50¢ level, the remaining $5 buys 8.33 shares at 60¢;
    // 18.33 shares for $10 = 54.545¢, rounded UP to 5455bp.
    assert.strictEqual(await quoteSideForDisplay("dq-walk", 1_000), 5455, "$10 walks the ladder (VWAP, rounded UP)");
    restore();
  }

  // A stake the book cannot fill -> null (the card is dropped, not approximated).
  {
    const restore = stubFetch((body) => body.map(({ token_id }) => bookPayload(token_id, [["0.52", "1"]])));
    assert.strictEqual(await quoteSideForDisplay("dq-thin", 1_000), null, "unfillable stake -> no display price");
    restore();
  }

  // Dead books — omitted from the response, or present with both sides empty -> null.
  {
    const restore = stubFetch((body) =>
      body.flatMap(({ token_id }) => (token_id === "dq-empty" ? [bookPayload(token_id, [], [])] : [])),
    );
    assert.strictEqual(await quoteSideForDisplay("dq-dead", 1_000), null, "omitted book -> no display price");
    assert.strictEqual(await quoteSideForDisplay("dq-empty", 1_000), null, "both-sides-empty book -> no display price");
    restore();
  }

  // CLOB down with nothing cached -> null (never a mid, never an exception leak).
  {
    const restore = stubFetchFailure(503);
    assert.strictEqual(await quoteSideForDisplay("dq-down", 1_000), null, "CLOB outage -> no display price");
    restore();
  }

  // A book served stale past the DISPLAY bound -> null. Prime the cache, let the TTL lapse, fail
  // upstream so the last-good book is served with its HONEST (old) fetchedAtMs, then jump the clock
  // past BOOK_MAX_DISPLAY_STALE_MS.
  {
    const ok = stubFetch((body) => body.map(({ token_id }) => bookPayload(token_id, [["0.52", "100"]])));
    assert.strictEqual(await quoteSideForDisplay("dq-stale", 100), 5200, "fresh book quotes fine");
    ok();
    await sleep(BOOK_CACHE_TTL_MS + 200); // let the fetch-throttle TTL lapse
    const down = stubFetchFailure(500);
    const realNow = Date.now;
    Date.now = () => realNow() + BOOK_MAX_DISPLAY_STALE_MS + 60_000; // 1 min past the display bound
    try {
      assert.strictEqual(
        await quoteSideForDisplay("dq-stale", 100),
        null,
        "stale-served book past the display bound -> no display price",
      );
    } finally {
      Date.now = realNow;
      down();
    }
  }

  console.log("✓ depth gate: husk/empty/thin/slippy books dropped, healthy book kept, TXODDS untouched");
  console.log("✓ servability: no mid fallback (1a), rejection stamp (1b), display staleness bound (1c)");
  console.log("✓ display-quote: stake-dependent VWAP, dead/down/stale books -> dropped, never a mid");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
