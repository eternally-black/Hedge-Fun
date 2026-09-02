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
import { gammaGetWithRetry, gammaWalkByEndDate, GammaStatusError, withGammaDeadline } from "../src/lib/polymarket";

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

  // 7. The offset cliff (prod 2026-08-26, tag_id=39 offset=700): past the cheap zone Gamma's own
  //    query budget kills the request, so retrying the same deep page just re-rolls the same loss.
  //    The endDate-cursor walk must therefore (a) never ask for an offset at all while the cursor can
  //    move, (b) still return the WHOLE pool, and (c) return each market once even though every page
  //    re-reads the instant it stopped on. The fake below is the real shape: endDate-ascending,
  //    end_date_min INCLUSIVE, 7 markets per instant (live max: 45), 500 for any offset >= 300.
  const POOL = Array.from({ length: 748 }, (_, i) => ({
    conditionId: `c${i}`,
    endDate: new Date(Date.UTC(2026, 7, 26) + Math.floor(i / 7) * 60_000).toISOString(),
  }));
  const offsetsAsked: number[] = [];
  const typesAsked: string[][] = [];
  const gamma = async (p: string) => {
    const q = new URLSearchParams(p.split("?")[1]);
    const off = Number(q.get("offset"));
    offsetsAsked.push(off);
    typesAsked.push(q.getAll("sports_market_types"));
    if (off >= 300) throw err(500); // the measured cliff
    const min = q.get("end_date_min") ?? "";
    return POOL.filter((m) => m.endDate >= min).slice(off, off + Number(q.get("limit"))) as never;
  };
  // The array value must REPEAT the key, not join it: Gamma ORs repeated params and 422s a comma
  //  list, and that is how the S2 fetch asks for both moneyline flavours.
  const walked = await gammaWalkByEndDate(
    { tag_id: "39", sports_market_types: ["moneyline", "child_moneyline"] },
    POOL[0].endDate,
    { get: gamma },
  );
  assert.deepEqual(typesAsked[0], ["moneyline", "child_moneyline"], "an array param must repeat the key");
  const unique = new Set(walked.map((m) => m.conditionId));
  assert.equal(unique.size, POOL.length, "the walk must cover the WHOLE pool, deep tail included");
  assert.equal(walked.length, unique.size, "the re-read boundary instant must be deduped, not duplicated");
  assert.deepEqual([...new Set(offsetsAsked)], [0], "a cursor that can move needs no offset — that's the whole fix");

  // 8. The one case a time cursor cannot step over: MORE markets share one endDate than a page holds,
  //    so end_date_min can't advance (live: the sports fetch, >300 markets on one top of the hour —
  //    it truncated a 576-market pool while this was being written). The walk must page that instant
  //    deeper and still come back whole, because a short read here is a lie, not a saving.
  const PILE = Array.from({ length: 400 }, (_, i) => ({ conditionId: `p${i}`, endDate: "2026-09-01T00:00:00.000Z" }));
  const pileOffsets: number[] = [];
  const piled = await gammaWalkByEndDate({}, PILE[0].endDate, {
    get: async (p) => {
      const q = new URLSearchParams(p.split("?")[1]);
      const off = Number(q.get("offset"));
      pileOffsets.push(off);
      return PILE.slice(off, off + Number(q.get("limit"))) as never;
    },
  });
  assert.equal(piled.length, PILE.length, "a pile-up on one endDate must be paged through, not truncated");
  assert.deepEqual(pileOffsets, [0, 100, 200, 300, 400], "and it must walk it once, in order, then stop");

  // 9. A Gamma time budget (withGammaDeadline) that has already run out refuses the NEXT read before
  //    it is attempted — this is what ends a walk within one request during an outage.
  calls = 0;
  await assert.rejects(
    withGammaDeadline(0, () => gammaGetWithRetry("/x", async () => { calls++; return page(100); })),
    /time budget exhausted/,
    "an expired budget must refuse the read",
  );
  assert.equal(calls, 0, "nothing is fetched past the deadline");

  // 10. A budget that runs out MID-ladder cuts the retries short instead of spending all four.
  calls = 0;
  await assert.rejects(
    withGammaDeadline(300, () => gammaGetWithRetry("/x", async () => { calls++; throw err(500); })),
    /time budget exhausted/,
    "the ladder must give up at the deadline",
  );
  assert.ok(calls >= 1 && calls < 4, `the ladder must stop early inside the budget (calls=${calls})`);

  // 11. The walk composes with it: page reads go through the retry, so an expired budget ends the
  //     walk on its next page with the injected fetch never called.
  calls = 0;
  await assert.rejects(
    withGammaDeadline(0, () =>
      gammaWalkByEndDate({}, "2026-09-01T00:00:00.000Z", {
        get: (p) => gammaGetWithRetry(p, async () => { calls++; return page(100); }),
      }),
    ),
    /time budget exhausted/,
    "an expired budget must end the walk",
  );
  assert.equal(calls, 0, "the walk must not fetch past the deadline");

  console.log("✓ test-gamma-retry: transient 5xx heals, real failure stays loud, paging never truncates, a time budget ends a walk");

}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
