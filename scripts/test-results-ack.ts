// Exact results acknowledgements: a GET page is the receipt. POST may mark only those ids, in the
// mode that produced that page; concurrent settlements and another user's rows remain unread.
// Run: npx tsx scripts/test-results-ack.ts (needs DATABASE_URL)
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import { randomCode } from "../src/lib/refcode";

process.env.SENTRY_DSN = "";
process.env.NEXT_PUBLIC_SENTRY_DSN = "";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";

const tag = `results-ack-${process.pid}-${Date.now() & 0xffffff}`;
const didA = `did:privy:${tag}-a`;
const didB = `did:privy:${tag}-b`;
(PrivyClient.prototype as unknown as { verifyAuthToken: (token: string) => Promise<{ userId: string }> }).verifyAuthToken = async (token: string) => {
  if (token === "a") return { userId: didA };
  if (token === "b") return { userId: didB };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: (id: string) => Promise<unknown> }).getUser = async (id: string) => ({
  email: { address: `${id}@test.local` }, twitter: null, wallet: null, linkedAccounts: [],
});

const request = (token: string, body?: unknown) => new Request("http://x/api/results/seen", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const results = await import("../src/app/api/results/route");
  const seen = await import("../src/app/api/results/seen/route");
  const userA = await prisma.user.create({ data: { privyId: didA, email: `${didA}@test.local`, authProvider: "EMAIL", referralCode: randomCode() } });
  const userB = await prisma.user.create({ data: { privyId: didB, email: `${didB}@test.local`, authProvider: "EMAIL", referralCode: randomCode() } });
  const now = Date.now();
  let marketSeq = 0;
  const createBet = async (userId: string, mode: "PAPER" | "REAL", n: number) => {
    const market = await prisma.market.create({ data: {
      polymarketId: `${tag}-${marketSeq++}`,
      question: "Which result did this page deliver?",
      status: "RESOLVED",
      resolvedOutcome: "YES",
      resolutionDeadline: new Date(Date.now() - 60_000),
    } });
    return prisma.bet.create({ data: {
      userId, marketId: market.id, side: "YES", mode, source: "DECK", stakeCents: 100,
      lockedPriceBp: 5000, utcDay: "2026-09-19", settlementStatus: "SETTLED", result: "WIN",
      pnlCents: 100, settledAt: new Date(now + n), createdAt: new Date(now + n),
    } });
  };

  try {
    for (let i = 0; i < 51; i++) await createBet(userA.id, "PAPER", i);
    const other = await createBet(userB.id, "PAPER", 500);
    const real = await createBet(userA.id, "REAL", 600);

    const page = await (await results.GET(new Request("http://x/api/results", { headers: { authorization: "Bearer a" } }))).json() as {
      mode: "PAPER" | "REAL"; rows: { id: string }[]; unreadCount: number; nextCursor: string | null;
    };
    assert.strictEqual(page.mode, "PAPER");
    assert.strictEqual(page.rows.length, 50, "GET delivers only the first 50 of 51");
    assert.strictEqual(page.unreadCount, 51);
    assert.ok(page.nextCursor);

    // Settles after GET, before ACK: it was not delivered and must stay unread.
    const concurrent = await createBet(userA.id, "PAPER", 700);
    const delivered = page.rows.map((row) => row.id);
    const ack = await seen.POST(request("a", { mode: page.mode, betIds: [...delivered, delivered[0]] }));
    assert.strictEqual(ack.status, 200);
    assert.strictEqual(((await ack.json()) as { markedSeen: number }).markedSeen, 50, "duplicate ids stay idempotent");
    assert.strictEqual(await prisma.bet.count({ where: { userId: userA.id, mode: "PAPER", seenAt: null } }), 2, "51st + concurrent row remain unread");
    assert.strictEqual((await prisma.bet.findUniqueOrThrow({ where: { id: concurrent.id } })).seenAt, null);
    const unseenPage = await (await results.GET(new Request("http://x/api/results?unseen=1", {
      headers: { authorization: "Bearer a" },
    }))).json() as { rows: { id: string }[]; unreadCount: number; nextCursor: string | null };
    assert.strictEqual(unseenPage.rows.length, 2, "ritual delivery surfaces older unread rows behind seen history");
    assert.strictEqual(unseenPage.unreadCount, 2);
    assert.strictEqual(unseenPage.nextCursor, null);

    const second = await seen.POST(request("a", { mode: page.mode, betIds: delivered }));
    assert.strictEqual(((await second.json()) as { markedSeen: number }).markedSeen, 0, "replay is idempotent");
    const empty = await seen.POST(request("a"));
    assert.strictEqual(((await empty.json()) as { markedSeen: number }).markedSeen, 0, "legacy empty POST is a safe no-op");

    const wrongOwner = await seen.POST(request("a", { mode: "PAPER", betIds: [other.id] }));
    assert.strictEqual(((await wrongOwner.json()) as { markedSeen: number }).markedSeen, 0);
    assert.strictEqual((await prisma.bet.findUniqueOrThrow({ where: { id: other.id } })).seenAt, null, "another user's row cannot be cleared");

    const wrongMode = await seen.POST(request("a", { mode: "PAPER", betIds: [real.id] }));
    assert.strictEqual(((await wrongMode.json()) as { markedSeen: number }).markedSeen, 0);
    assert.strictEqual((await prisma.bet.findUniqueOrThrow({ where: { id: real.id } })).seenAt, null, "mode mismatch cannot clear a row");
    assert.strictEqual((await seen.POST(request("a", { mode: "LIVE", betIds: [real.id] }))).status, 400, "malformed mode is rejected");
    assert.strictEqual((await seen.POST(request("a", { mode: "PAPER", betIds: Array.from({ length: 101 }, (_, i) => String(i)) }))).status, 400, "ACK is bounded");

    // Stock-only payloads keep their old independent semantics and do not require a bet mode.
    const stocksOnly = await seen.POST(request("a", { scope: "stocks", stockAlerts: [] }));
    assert.strictEqual(stocksOnly.status, 200);
    assert.deepStrictEqual(await stocksOnly.json(), { markedSeen: 0, markedStockAlertsSeen: 0 });

    console.log("PASS: results-ack exact page/mode/owner semantics");
  } finally {
    await prisma.bet.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.virtualBalance.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.market.deleteMany({ where: { polymarketId: { startsWith: tag } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
