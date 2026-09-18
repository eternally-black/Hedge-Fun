// Durable cursor fairness for the two bounded Polymarket money sweeps. Pure fakes keep this test
// hermetic while exercising the production query/cursor/control flow.
// Run: npx tsx scripts/test-sweep-fairness.ts
import assert from "node:assert";
import type { PrismaClient } from "@prisma/client";
import { reconcileStuckAttempts } from "../src/lib/reconcile";
import { settleResolvedRealPositions } from "../src/lib/real-settle";

process.env.SENTRY_DSN = "";
process.env.NEXT_PUBLIC_SENTRY_DSN = "";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";

type Cursor = { afterCreatedAt: Date | null; afterId: string | null; updatedAt: Date };

const tupleAfter = (row: { createdAt: Date; id: string }, cursor: { createdAt: Date; id: string } | null) =>
  !cursor || row.createdAt > cursor.createdAt || (+row.createdAt === +cursor.createdAt && row.id > cursor.id);
const cursorFromWhere = (where: any): { createdAt: Date; id: string } | null => {
  const or = where?.AND?.[0]?.OR;
  if (!or) return null;
  return { createdAt: or[0].createdAt.gt, id: or[1].id.gt };
};

async function reconciliationFairness() {
  const base = new Date("2026-09-19T12:00:00Z");
  const cursors = new Map<string, Cursor>();
  const rows = Array.from({ length: 22 }, (_, i) => ({
    id: `r${String(i).padStart(3, "0")}`,
    userId: "u",
    marketId: "m",
    dir: "ENTRY",
    state: "POSTED",
    externalOrderId: `o${i}`,
    approvedParams: { sharesMicro: "1000000" },
    signedOrder: null,
    lotSeq: 0,
    createdAt: new Date(base.getTime() - (22 - i) * 1000),
    // The first two explicitly prove that 49-hour and 49-day attempts do not age out.
    updatedAt: new Date(base.getTime() - (i === 0 ? 49 * 86_400_000 : i === 1 ? 49 * 3_600_000 : 86_400_000)),
    reconciledAt: null,
  }));
  let killed = 0;
  const makePrisma = () => ({
    sweepCursor: {
      findUnique: async ({ where }: any) => {
        const c = cursors.get(where.name);
        return c ? { name: where.name, ...c } : null;
      },
      upsert: async ({ where, create, update }: any) => {
        const data = cursors.has(where.name) ? update : create;
        cursors.set(where.name, { afterCreatedAt: data.afterCreatedAt, afterId: data.afterId, updatedAt: currentNow });
        return { name: where.name, ...cursors.get(where.name)! };
      },
    },
    orderAttempt: {
      findMany: async ({ where, take }: any) => {
        const cursor = cursorFromWhere(where);
        return rows
          .filter((row) => row.state === "POSTED" && row.externalOrderId && row.updatedAt < where.updatedAt.lt && tupleAfter(row, cursor))
          .sort((a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id))
          .slice(0, take);
      },
      updateMany: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row || row.state !== "POSTED") return { count: 0 };
        row.state = data.state;
        killed++;
        return { count: 1 };
      },
    },
    market: { findUnique: async () => ({ feeExpMilli: 1000 }) },
    dailyCounter: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
  }) as unknown as PrismaClient;
  let currentNow = base;
  let fake = makePrisma();
  const probed = new Map<string, number>();
  const probe = async (attempt: { id: string }) => {
    probed.set(attempt.id, (probed.get(attempt.id) ?? 0) + 1);
    return attempt.id === "r021"
      ? { terminal: true, matchedSharesMicro: 0n, trades: [] }
      : null;
  };

  const first = await reconcileStuckAttempts(fake, probe, { now: currentNow, minAgeMs: 10 * 60_000, limit: 20 });
  assert.strictEqual(first.scanned, 20);
  assert.strictEqual(first.unknown, 20);
  assert.ok(probed.has("r000") && probed.has("r001"), "49-day and 49-hour POSTED rows remain eligible");

  // A restart continues the active traversal immediately, so the later terminal row is not held
  // behind a job-wide cooldown.
  currentNow = new Date(base.getTime() + 1);
  fake = makePrisma();
  const second = await reconcileStuckAttempts(fake, probe, { now: currentNow, minAgeMs: 10 * 60_000, limit: 20 });
  assert.strictEqual(second.scanned, 2);
  assert.strictEqual(second.killed, 1, "later terminal attempt is reached behind unknown head rows");
  assert.strictEqual(killed, 1);

  currentNow = new Date(base.getTime() + 2);
  const wrapped = await reconcileStuckAttempts(makePrisma(), probe, { now: currentNow, minAgeMs: 10 * 60_000, limit: 20 });
  assert.strictEqual(wrapped.scanned, 0, "end of traversal records the durable cooldown marker");
  currentNow = new Date(base.getTime() + 3);
  const tooSoon = await reconcileStuckAttempts(makePrisma(), probe, { now: currentNow, minAgeMs: 10 * 60_000, limit: 20 });
  assert.strictEqual(tooSoon.scanned, 0, "completed traversal enforces the minimum retry interval");
  assert.strictEqual(probed.get("r000"), 1, "unknown head is not hot-looped during cooldown");

  currentNow = new Date(base.getTime() + 10 * 60_000 + 3);
  await reconcileStuckAttempts(makePrisma(), probe, { now: currentNow, minAgeMs: 10 * 60_000, limit: 20 });
  assert.strictEqual(killed, 1, "terminal booking is not duplicated after wrap/restart");
}

async function settlementFairness() {
  const createdAt = new Date("2026-09-19T12:00:00Z");
  const cursors = new Map<string, Cursor>();
  const rows = Array.from({ length: 201 }, (_, i) => ({
    id: `b${String(i).padStart(3, "0")}`,
    createdAt,
    side: i < 200 ? "YES" : "NO",
    filledSharesMicro: 1_000_000n,
    closedSharesMicro: null as bigint | null,
    userId: `u${i}`,
    marketId: `m${i}`,
    source: "DECK",
    spendMicro: 500_000n,
    feeMicro: 0n,
    realizedPnlMicro: 0n,
    proceedsMicro: 0n,
    settlementStatus: "PENDING",
    market: { status: "RESOLVED", resolvedOutcome: "YES", negRisk: false, yesTokenId: `y${i}`, noTokenId: `n${i}` },
    user: { depositWalletAddress: `0x${String(i).padStart(40, "0")}` },
    updates: 0,
  }));
  let clock = createdAt;
  const makePrisma = () => {
    const tx = {
      $queryRaw: async () => [],
      bet: {
        findUnique: async ({ where }: any) => rows.find((row) => row.id === where.id) ?? null,
        update: async ({ where, data }: any) => {
          const row = rows.find((r) => r.id === where.id)!;
          row.closedSharesMicro = data.closedSharesMicro;
          row.settlementStatus = data.settlementStatus;
          row.updates++;
          return row;
        },
      },
      shardGrant: {}, collectibleBalance: {}, dailyCounter: {},
    };
    return ({
      sweepCursor: {
        findUnique: async ({ where }: any) => {
          const c = cursors.get(where.name);
          return c ? { name: where.name, ...c } : null;
        },
        upsert: async ({ where, create, update }: any) => {
          const data = cursors.has(where.name) ? update : create;
          cursors.set(where.name, { afterCreatedAt: data.afterCreatedAt, afterId: data.afterId, updatedAt: clock });
          return { name: where.name, ...cursors.get(where.name)! };
        },
      },
      bet: {
        findMany: async ({ where, take }: any) => {
          const cursor = cursorFromWhere(where);
          return rows
            .filter((row) => row.settlementStatus === "PENDING" && row.filledSharesMicro > 0n && tupleAfter(row, cursor))
            .sort((a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id))
            .slice(0, take);
        },
      },
      orderAttempt: { findMany: async () => [] },
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    }) as unknown as PrismaClient;
  };

  const first = await settleResolvedRealPositions(makePrisma(), async () => 1_000_000n);
  assert.strictEqual(first.winnersPending, 200);
  assert.strictEqual(first.lost, 0);

  // Restart: only the durable cursor survives. The 201st row is a loser and must not be pinned by
  // the 200 held winners.
  clock = new Date(clock.getTime() + 1);
  const second = await settleResolvedRealPositions(makePrisma(), async () => 1_000_000n);
  assert.strictEqual(second.lost, 1);
  assert.strictEqual(rows[200].updates, 1);

  // Delete the anchor and restart again. Tuple keysets do not need the anchor row to exist.
  rows.splice(200, 1);
  rows.push({
    ...rows[0], id: "b201", side: "NO", userId: "u201", marketId: "m201",
    closedSharesMicro: null, settlementStatus: "PENDING", updates: 0,
  });
  const third = await settleResolvedRealPositions(makePrisma(), async () => 1_000_000n);
  assert.strictEqual(third.lost, 1, "deleted cursor anchor does not prevent later settlement");
  assert.strictEqual(rows.find((r) => r.id === "b201")!.updates, 1);

  await settleResolvedRealPositions(makePrisma(), async () => 1_000_000n);
  assert.strictEqual(rows.find((r) => r.id === "b201")!.updates, 1, "settled row is never booked twice");
}

Promise.all([reconciliationFairness(), settlementFairness()])
  .then(() => console.log("PASS: durable sweep fairness"))
  .catch((e) => { console.error("FAIL:", e); process.exit(1); });
