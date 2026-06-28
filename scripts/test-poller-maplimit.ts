// Unit test for the poller's mapLimit (the bounded-concurrency worker pool that settles markets
// each tick). Two properties the settlement loop relies on:
//   (1) ERROR ISOLATION — one market's fetchResolution throwing is "transient, retry next tick";
//       it must NOT reject the whole run, so every OTHER market in the same tick still settles.
//   (2) BOUNDED CONCURRENCY — at most `limit` items run at once, so we never open N parallel
//       Polymarket fetches / DB writes for a big pending set.
// DB-free + network-free: importing scripts/poller.ts does NOT start the daemon (runAsDaemon guard
// keys off process.argv[1] ending in "poller.ts"), so this is a pure import. Run: npx tsx scripts/test-poller-maplimit.ts
import assert from "node:assert";
import { mapLimit } from "./poller";

// A fn that records concurrency and throws for one specific item. Each call holds a "slot" for a
// microtask turn (await a resolved promise) so overlapping workers are actually observed in-flight.
function makeFn(throwOn: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  const processed: number[] = [];
  const fn = async (n: number) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // Yield a few turns so siblings get scheduled while this one is "working".
      await Promise.resolve();
      await Promise.resolve();
      if (n === throwOn) throw new Error(`boom on ${n}`);
      processed.push(n);
    } finally {
      inFlight--;
    }
  };
  return { fn, processed, maxConcurrency: () => maxInFlight };
}

async function main() {
  const N = 20;
  const LIMIT = 4;
  const items = Array.from({ length: N }, (_, i) => i);

  // ---- (1) error isolation: item 7 throws; the run still resolves and everyone else processes ----
  const t = makeFn(7);
  await assert.doesNotReject(
    mapLimit(items, LIMIT, t.fn),
    "a thrown item must NOT reject the whole mapLimit run (it's a per-item transient)",
  );
  const expected = items.filter((n) => n !== 7);
  assert.deepStrictEqual(t.processed.toSorted((a, b) => a - b), expected,
    "every non-throwing item is processed despite item 7 throwing");
  assert.ok(!t.processed.includes(7), "the throwing item is isolated (not counted as processed)");

  // ---- (2) bounded concurrency: never more than LIMIT workers in flight ----
  assert.ok(t.maxConcurrency() <= LIMIT, `concurrency bounded by ${LIMIT} (saw ${t.maxConcurrency()})`);
  // And the pool actually parallelizes up to the bound (N > LIMIT, so it should saturate).
  assert.strictEqual(t.maxConcurrency(), LIMIT, `pool saturates to ${LIMIT} when items > limit`);

  // ---- edge: limit larger than item count -> at most `items.length` workers, no error ----
  const few = makeFn(-1); // never throws
  await mapLimit([1, 2], 10, few.fn);
  assert.deepStrictEqual(few.processed.toSorted((a, b) => a - b), [1, 2], "all items run when limit > N");
  assert.ok(few.maxConcurrency() <= 2, "concurrency capped at item count when limit > N");

  // ---- edge: empty input is a clean no-op ----
  const none = makeFn(-1);
  await mapLimit([], LIMIT, none.fn);
  assert.strictEqual(none.processed.length, 0, "empty input processes nothing");

  console.log("OK: mapLimit isolates per-item errors and bounds concurrency at the limit");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
