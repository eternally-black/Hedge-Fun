// /api/history follows the account's MODE, and reports a real position by its MONEY outcome.
//
// Why this needs its own test: the paper settle job never touches a REAL row, so settlementStatus
// stays PENDING on one forever. If history read that column for real rows, a closed and paid-out
// position would render as still open — the user's own money, reported wrong. Status therefore comes
// from the share remainder and P&L from realizedPnlMicro, and both halves are pinned here.
//
// Run: npx tsx scripts/test-history-mode.ts
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import { randomCode } from "../src/lib/refcode";

// The stub must be installed BEFORE the route module is imported — authUser resolves through it.
const STUB_DID = `did:privy:histmode-${process.pid}-${Date.now() & 0xffffff}`;
(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: STUB_DID };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => ({
  email: { address: `${STUB_DID}@test.local` },
  twitter: null,
  wallet: null,
  linkedAccounts: [],
});

type Row = { id: string; status: string; pnlCents: number | null };

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const history = await import("../src/app/api/history/route");
  const authed = () => new Request("http://x/api/history", { headers: { authorization: "Bearer good" } });
  const rowsNow = async (): Promise<Row[]> => ((await (await history.GET(authed())).json()) as { rows: Row[] }).rows;

  const user = await prisma.user.create({
    data: {
      privyId: STUB_DID,
      email: `${STUB_DID}@test.local`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
    },
  });
  const market = await prisma.market.create({
    data: {
      polymarketId: `histmode-${STUB_DID}`,
      question: "Does history follow the mode?",
      outcomeYesLabel: "Yes",
      outcomeNoLabel: "No",
      yesPriceBp: 5000,
      noPriceBp: 5000,
      resolutionDeadline: new Date(Date.now() + 86_400_000),
      source: "POLYMARKET",
      status: "OPEN",
    },
  });

  const mkBet = (mode: "PAPER" | "REAL") =>
    prisma.bet.create({
      data: {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        stakeCents: 100,
        lockedPriceBp: 5000,
        utcDay: new Date().toISOString().slice(0, 10),
        mode,
        source: "DECK",
      },
      select: { id: true },
    });

  try {
    const paperBet = await mkBet("PAPER");
    const realBet = await mkBet("REAL");

    // ── PAPER mode shows the paper bet and hides the real one ──────────────────────────────────
    const paperView = await rowsNow();
    assert.ok(paperView.some((r) => r.id === paperBet.id), "paper mode lists the paper bet");
    assert.ok(!paperView.some((r) => r.id === realBet.id), "paper mode hides real positions");

    // ── REAL mode: the inverse, and a position still holding shares reads as open ──────────────
    await prisma.user.update({ where: { id: user.id }, data: { realMode: true } });
    await prisma.bet.update({
      where: { id: realBet.id },
      data: { filledSharesMicro: 10_000_000n, closedSharesMicro: 0n, realizedPnlMicro: 0n },
    });
    const openView = await rowsNow();
    assert.ok(!openView.some((r) => r.id === paperBet.id), "real mode hides paper bets");
    const openRow = openView.find((r) => r.id === realBet.id);
    assert.ok(openRow, "real mode lists the real position");
    assert.strictEqual(openRow.status, "PENDING", "shares still held = open");

    // ── Fully closed at a profit: WIN, P&L converted micro-USD → cents ─────────────────────────
    await prisma.bet.update({
      where: { id: realBet.id },
      data: { closedSharesMicro: 10_000_000n, realizedPnlMicro: 1_250_000n },
    });
    const doneRow = (await rowsNow()).find((r) => r.id === realBet.id);
    assert.ok(doneRow, "closed position still listed");
    assert.strictEqual(doneRow.status, "WIN", "a closed position reports its MONEY outcome");
    assert.strictEqual(doneRow.pnlCents, 125, "1_250_000 micro-USD = 125 cents");

    // ── A loss is a loss, even though the paper column never moved off PENDING ─────────────────
    await prisma.bet.update({ where: { id: realBet.id }, data: { realizedPnlMicro: -400_000n } });
    assert.strictEqual((await rowsNow()).find((r) => r.id === realBet.id)?.status, "LOSS", "negative realized = LOSS");
    const untouched = await prisma.bet.findUniqueOrThrow({ where: { id: realBet.id } });
    assert.strictEqual(untouched.settlementStatus, "PENDING", "…while settlementStatus never moved");

    // ── Break-even closes as PUSH, not as a win ────────────────────────────────────────────────
    await prisma.bet.update({ where: { id: realBet.id }, data: { realizedPnlMicro: 0n } });
    assert.strictEqual((await rowsNow()).find((r) => r.id === realBet.id)?.status, "PUSH", "zero realized = PUSH");

    console.log("OK: history follows the mode; real positions report realized P&L, not paper status");
    console.log("PASS: history-mode");
  } finally {
    await prisma.bet.deleteMany({ where: { userId: user.id } });
    await prisma.market.deleteMany({ where: { id: market.id } });
    await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });
