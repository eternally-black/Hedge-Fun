// DB-backed test for the stock profit-alert path: evaluator -> /api/me unread -> /api/results rows
// -> /api/results/seen acknowledgement. Calls the REAL route handlers with a Privy prototype stub
// (like test-stocks-db.ts). P&L is injected so the test drives the tier without a price feed.
// Needs DATABASE_URL. Run: npx tsx scripts/test-stock-alerts-db.ts
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";

const RUN = `${process.pid}-${Date.now() & 0xffffff}`;
const DID = `did:privy:salerts-${RUN}`;
const MINT = `mint-alerts-${RUN}`;

(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: DID };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => ({
  email: { address: `${DID}@test.local` },
  twitter: null,
  wallet: null,
  linkedAccounts: [],
});

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { evalStockAlerts } = await import("../src/lib/stock-alerts");
  const me = await import("../src/app/api/me/route");
  const results = await import("../src/app/api/results/route");
  const seen = await import("../src/app/api/results/seen/route");

  const headers = { authorization: "Bearer good", "content-type": "application/json" };
  const get = (url: string) => new Request(url, { headers });
  const post = (url: string, body?: unknown) =>
    new Request(url, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const meUnread = async () => ((await (await me.GET(get("http://x/api/me"))).json()) as { unreadStockAlerts?: number }).unreadStockAlerts;
  const seenRes = async (body?: unknown) =>
    (await (await seen.POST(post("http://x/api/results/seen", body))).json()) as { markedStockAlertsSeen: number };
  const resultsRes = async () =>
    (await (await results.GET(get("http://x/api/results"))).json()) as { stockAlerts: { positionId: string; seen: boolean }[] };

  let userId: string | null = null;
  let assetId: string | null = null;

  // Mutable P&L the test drives between steps. The evaluator takes it as an argument.
  let pnlNow = 0;
  const pnl = () => pnlNow;

  try {
    assert.strictEqual((await me.GET(get("http://x/api/me"))).status, 200, "me provisions user");
    const user = await prisma.user.findUniqueOrThrow({ where: { privyId: DID } });
    userId = user.id;

    const asset = await prisma.stockAsset.create({
      data: {
        mint: MINT,
        symbol: `ALTx-${RUN}`,
        name: `Alert xStock ${RUN}`,
        underlying: "ALT",
        decimals: 8,
        deckEligible: true,
        priceCents: 10_000,
        liquidityCents: 9_000_000,
        pricedAt: new Date(),
      },
      select: { id: true },
    });
    assetId = asset.id;

    // One PAPER lot: 1 token at $100 (qtyBase 10_000_000 raw units, cost 10000c).
    const lot = await prisma.stockPosition.create({
      data: { userId: user.id, assetId: asset.id, mode: "PAPER", qtyBase: 10_000_000n, costCents: 10_000, entryPriceCents: 10_000 },
      select: { id: true },
    });

    // (1) +1% -> nothing fires, nothing unread.
    pnlNow = 100;
    let sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 0, "(1) +1% fires nothing");
    assert.strictEqual(await meUnread(), 0, "(1) unreadStockAlerts 0");

    // (2) +2.5% -> tier 200 fires once.
    pnlNow = 250;
    sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 1, "(2) +2.5% fires one tier");
    const lotAfter = await prisma.stockPosition.findUniqueOrThrow({ where: { id: lot.id } });
    assert.strictEqual(lotAfter.alertTierBp, 200, "(2) alertTierBp 200");
    assert.strictEqual(lotAfter.alertSeenAt, null, "(2) alertSeenAt null");
    assert.strictEqual(await meUnread(), 1, "(2) unreadStockAlerts 1");

    const resBody = await resultsRes();
    assert.strictEqual(resBody.stockAlerts.length, 1, "(2) one stock alert row");
    assert.deepStrictEqual(
      Object.keys(resBody.stockAlerts[0]!).sort(),
      ["alertedAt", "costCents", "logoUrl", "mode", "name", "pnlBp", "pnlCents", "positionId", "seen", "symbol", "tierBp"],
      "(2) stock alert row keys",
    );
    assert.strictEqual(resBody.stockAlerts[0]!.seen, false, "(2) row unseen");

    // (3) rerun -> the conditional update is the idempotency.
    sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 0, "(3) rerun fires nothing");

    // (4) acknowledgement semantics.
    assert.strictEqual((await seenRes()).markedStockAlertsSeen, 0, "(4) no body -> bets only");
    assert.strictEqual(await meUnread(), 1, "(4) still unread after no-body POST");
    assert.strictEqual((await seenRes({ scope: "bets" })).markedStockAlertsSeen, 0, "(4) scope bets -> 0");
    assert.strictEqual(await meUnread(), 1, "(4) still unread after scope bets");
    assert.strictEqual((await seenRes({ scope: "both", stockAlerts: [{ positionId: lot.id, tierBp: 999 }] })).markedStockAlertsSeen, 0, "(4) stale tier -> 0");
    assert.strictEqual(await meUnread(), 1, "(4) still unread after stale tier");
    assert.strictEqual((await seenRes({ scope: "both", stockAlerts: [{ positionId: lot.id, tierBp: 200 }] })).markedStockAlertsSeen, 1, "(4) delivered pair -> 1");
    assert.strictEqual(await meUnread(), 0, "(4) unread 0 after ack");

    // (5) +6% -> tier 500 fires, unread again.
    pnlNow = 600;
    sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 1, "(5) +6% fires tier 500");
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: lot.id } })).alertTierBp, 500, "(5) alertTierBp 500");
    assert.strictEqual(await meUnread(), 1, "(5) unread 1 again");

    // (6) +4% -> monotonic, nothing fires.
    pnlNow = 400;
    sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 0, "(6) +4% after 500 -> 0");

    // (7) stale price -> nothing fires.
    await prisma.stockAsset.update({ where: { id: asset.id }, data: { pricedAt: new Date(Date.now() - 10 * 60_000) } });
    pnlNow = 1_200;
    sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 0, "(7) stale price -> 0");
    await prisma.stockAsset.update({ where: { id: asset.id }, data: { pricedAt: new Date() } });

    // (8) REAL lot with no wallet reconciliation -> nothing; with a fresh one -> tier 1000.
    const realLot = await prisma.stockPosition.create({
      data: { userId: user.id, assetId: asset.id, mode: "REAL", qtyBase: 10_000_000n, costCents: 10_000, entryPriceCents: 10_000, walletCheckedAt: null },
      select: { id: true },
    });
    pnlNow = 1_200;
    sweep = await evalStockAlerts(prisma, pnl);
    // The PAPER lot (tier 500) legitimately moves to 1000 here; the REAL lot must stay at 0.
    assert.strictEqual(sweep.fired, 1, "(8) only the paper lot fires; REAL with no wallet check stays silent");
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: realLot.id } })).alertTierBp, 0, "(8) REAL tier stays 0 without a wallet check");
    await prisma.stockPosition.update({ where: { id: realLot.id }, data: { walletCheckedAt: new Date() } });
    sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 1, "(8) REAL with fresh wallet check -> fires");
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: realLot.id } })).alertTierBp, 1_000, "(8) REAL tier 1000");
    assert.strictEqual(await meUnread(), 2, "(8) both modes count (REAL alert counted for a PAPER-mode user)");

    // (9) a closed lot is not touched and no longer listed.
    await prisma.stockPosition.update({ where: { id: lot.id }, data: { closedAt: new Date() } });
    pnlNow = 2_000;
    sweep = await evalStockAlerts(prisma, pnl);
    assert.strictEqual(sweep.fired, 0, "(9) closed lot not touched");
    const resAfter = await resultsRes();
    assert.ok(!resAfter.stockAlerts.some((r) => r.positionId === lot.id), "(9) closed lot not listed");

    console.log("test-stock-alerts-db: OK");
  } finally {
    if (userId) {
      await prisma.stockPosition.deleteMany({ where: { userId } });
      await prisma.stockPass.deleteMany({ where: { userId } });
      await prisma.stockBuyAttempt.deleteMany({ where: { userId } });
      await prisma.shardGrant.deleteMany({ where: { userId } });
      await prisma.bet.deleteMany({ where: { userId } });
      await prisma.pointsLedger.deleteMany({ where: { userId } });
      await prisma.loginMark.deleteMany({ where: { userId } });
      await prisma.dailyCounter.deleteMany({ where: { userId } });
      await prisma.streakEvent.deleteMany({ where: { userId } });
      await prisma.streak.deleteMany({ where: { userId } });
      await prisma.collectibleBalance.deleteMany({ where: { userId } });
      await prisma.virtualBalance.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    if (assetId) await prisma.stockAsset.deleteMany({ where: { id: assetId } });
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });
