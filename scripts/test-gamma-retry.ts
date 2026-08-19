// Gamma paging must survive a transient 5xx without truncating the pool — and must still fail loud
// when the failure is real. Offline (injected `once`), so it runs in `npm test` with no network.
//
// The bug this locks down (prod, [hedge-index] refresh error, fixed 2026-08-19): Gamma answers 500
// under CONCURRENCY, not at the end of a tag's pool. Measured live: 30/30 sequential 200s at
// offset=300, but 6 x 500 in a 24-request burst; the 500'd pages held 100 real markets each on retry.
// So "stop paging at the 500" would silently drop the tail of the index — the assertions below are
// written against the full pool, which is what catches that.
import assert from "node:assert/strict";
// The REAL error class, on purpose: the retry classifies with `instanceof`, so a look-alike defined
// here would test nothing (it silently made the 4xx case retry while this test was being written).
import { gammaGetWithRetry, GammaStatusError } from "../src/lib/polymarket";

const err = (status: number) => new GammaStatusError(status, "/x");
const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) })) as never;

async function main() {

  // 1. A transient 500 heals: the caller gets the page's REAL contents, not an empty list.
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls <= 2) throw err(500);
    return page(100);
  };
  assert.equal((await gammaGetWithRetry("/x", flaky)).length, 100, "a healed page must return its 100 markets");
  assert.equal(calls, 3, "should retry twice before succeeding");

  // 2. A PERSISTENT 500 still throws — an upstream outage stays loud, so subsystemFailed keeps meaning.
  calls = 0;
  await assert.rejects(
    gammaGetWithRetry("/x", async () => {
      calls++;
      throw err(500);
    }),
    /after 4 attempts/,
    "a real outage must not be swallowed",
  );
  assert.equal(calls, 4, "attempts are bounded — never an unbounded retry loop");

  // 3. A 4xx is a contract problem: thrown on the FIRST look, unretried.
  calls = 0;
  await assert.rejects(
    gammaGetWithRetry("/x", async () => {
      calls++;
      throw err(404);
    }),
    /Gamma 404/,
  );
  assert.equal(calls, 1, "a hard 4xx must not be retried");

  // 4. 429 IS retried (congestion, like a 5xx).
  calls = 0;
  await assert.rejects(gammaGetWithRetry("/x", async () => { calls++; throw err(429); }));
  assert.equal(calls, 4, "429 is congestion — retry it");

  // 5. Transport/timeout errors (no status) retry too, then surface.
  calls = 0;
  await assert.rejects(
    gammaGetWithRetry("/x", async () => {
      calls++;
      throw new Error("The operation was aborted due to timeout");
    }),
    /timeout.*after 4 attempts/,
  );
  assert.equal(calls, 4, "a timeout is transient — retry it");

  // 6. The paging invariant the fix exists to protect: a 500 on a MIDDLE page must not shorten the
  //    walk. Pages 0..6 are full, page 7 is the real (short) end; page 3 500s once.
  let seen = 0;
  const pool = [100, 100, 100, 100, 100, 100, 100, 67];
  let failedOnce = false;
  const walk = async (p: string) => {
    const off = Number(new URLSearchParams(p.split("?")[1]).get("offset"));
    if (off === 300 && !failedOnce) {
      failedOnce = true;
      throw err(500);
    }
    return page(pool[off / 100] ?? 0);
  };
  for (let i = 0; i < 8; i++) {
    const raw = await gammaGetWithRetry(`/markets?offset=${i * 100}`, walk);
    seen += raw.length;
    if (raw.length < 100) break;
  }
  assert.equal(seen, 767, "a transient 500 mid-walk must still yield the WHOLE pool, not a truncated one");

  console.log("✓ test-gamma-retry: transient 5xx heals, real failure stays loud, paging never truncates");

}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
