// The wall-clock budget (src/lib/deadline.ts) that keeps a poller tick under its heartbeat bound
// during an upstream outage: absent outside withDeadline, spent inside an expired one, never leaking
// past its scope, visible inside every mapLimit worker (the settle sweep's whole basis), and honoured
// by the Polygon RPC reader (the Gamma reader's cases live in test-gamma-retry.ts). Offline: fetch is
// stubbed. Part of `npm test`.
import assert from "node:assert/strict";
import { withDeadline, deadlineLeftMs, boundedTimeoutMs } from "../src/lib/deadline";
import { conditionResolution } from "../src/lib/polygon";
import { mapLimit } from "./poller";

async function main() {
  // 1. No budget by default; a live one counts down and clamps a reader's timeout; nothing leaks out.
  assert.equal(deadlineLeftMs(), undefined, "no budget in force by default");
  assert.equal(boundedTimeoutMs(15_000), 15_000, "no budget -> the reader's own bound");
  await withDeadline(10_000, async () => {
    const left = deadlineLeftMs();
    assert.ok(left !== undefined && left > 9_000 && left <= 10_000, `a live budget counts down (${left})`);
    assert.ok(Math.abs(boundedTimeoutMs(15_000) - left) <= 50, "a reader's timeout is clamped to what is left");
    assert.equal(boundedTimeoutMs(1_000), 1_000, "a bound smaller than the budget stays the bound");
  });
  assert.equal(deadlineLeftMs(), undefined, "the budget does not leak past its scope");
  await withDeadline(0, async () => {
    assert.ok((deadlineLeftMs() ?? 1) <= 0, "an expired budget reads as spent");
    assert.equal(boundedTimeoutMs(15_000), 1, "never a zero timeout");
  });

  // 2. The budget reaches every mapLimit worker (spawned inside the withDeadline callback, joined by
  //    Promise.all) and is gone once the sweep returns.
  const seen: boolean[] = [];
  await withDeadline(5_000, () =>
    mapLimit([1, 2, 3], 2, async () => {
      seen.push(deadlineLeftMs() !== undefined);
    }),
  );
  assert.deepEqual(seen, [true, true, true], "the budget is visible inside every worker");
  assert.equal(deadlineLeftMs(), undefined, "and gone once the sweep returns");

  // 3. The Polygon reader refuses a call once the budget is spent — fetch is never issued.
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      withDeadline(0, () => conditionResolution("0x" + "1".repeat(64))),
      /time budget exhausted before polygon rpc/,
      "a spent budget must refuse the rpc",
    );
    assert.equal(fetches, 0, "no request past the deadline");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("✓ test-deadline: scoped budget, clamped timeouts, every mapLimit worker sees it, polygon rpc refuses past the deadline");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
