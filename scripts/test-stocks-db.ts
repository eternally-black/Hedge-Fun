// DB-backed test for the PAPER tokenized-stock path: deck -> buy (idempotent) -> concurrent buy
// (Cash guard) -> pass -> portfolio -> sell -> bad bodies -> Jupiter outage. Calls the REAL route
// handlers with a Privy prototype stub (like test-route-guards.ts) and a fetch stub keyed by URL
// (like test-hedge-wallet-verified.ts). Needs DATABASE_URL.
// Run: npx tsx scripts/test-stocks-db.ts
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { PrivyClient } from "@privy-io/server-auth";
import { REAL_TERMS_VERSION } from "../src/lib/real-terms";

const RUN = `${process.pid}-${Date.now() & 0xffffff}`;
// The buy route requires a uuid-shaped requestId (hex + dashes); "req-…" strings are rejected with 400.
const rid = () => randomUUID();
const DID = `did:privy:stk-${RUN}`;
const MINT_A = `mintA-${RUN}`;
const MINT_B = `mintB-${RUN}`;
const MINT_C = `mintC-${RUN}`;

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

// Mutable price the test changes between steps. Any non-Jupiter URL is a stubbed outage.
let priceUsd = 334.16;
let jupiterDown = false;
// The canned LLM answer for the blurb step, keyed by symbol; filled once the symbols are known.
let blurbReply: Record<string, string> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/chat/completions")) {
    const body = { choices: [{ message: { content: JSON.stringify(blurbReply) } }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("lite-api.jup.ag/price")) {
    if (jupiterDown) throw new Error("stubbed outage");
    const body: Record<string, unknown> = {};
    for (const mint of [MINT_A, MINT_B, MINT_C]) {
      body[mint] = { usdPrice: priceUsd, decimals: 8, priceChange24h: 0.5, liquidity: 1e6 };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`stubbed outage: ${url}`);
}) as typeof fetch;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const me = await import("../src/app/api/me/route");
  const deck = await import("../src/app/api/stocks/deck/route");
  const buy = await import("../src/app/api/stocks/buy/route");
  const sell = await import("../src/app/api/stocks/sell/route");
  const pass = await import("../src/app/api/stocks/pass/route");
  const portfolio = await import("../src/app/api/stocks/portfolio/route");

  const headers = { authorization: "Bearer good", "content-type": "application/json" };
  const get = (url: string) => new Request(url, { headers });
  const post = (url: string, body: unknown) =>
    new Request(url, { method: "POST", headers, body: JSON.stringify(body) });

  let userId: string | null = null;
  const assetIds: string[] = [];

  try {
    // Provision the user via /api/me (the stub creates it), then read its VirtualBalance.
    assert.strictEqual((await me.GET(get("http://x/api/me"))).status, 200, "me provisions user");
    const user = await prisma.user.findUniqueOrThrow({ where: { privyId: DID } });
    userId = user.id;
    const vb0 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });

    // Seed two deck-eligible assets (A, B) + a third (C) for the pass test.
    // A carries a blurb, B and C do not — the deck card must mirror both cases verbatim.
    const mkAsset = (mint: string, symbol: string, blurb?: string) =>
      prisma.stockAsset.create({
        data: {
          mint,
          symbol,
          name: `${symbol} xStock`,
          underlying: symbol.replace(/x$/, ""),
          blurb: blurb ?? null,
          decimals: 8,
          deckEligible: true,
          priceCents: 33416,
          liquidityCents: 9_000_000,
          pricedAt: new Date(),
        },
        select: { id: true },
      });
    const A = await mkAsset(MINT_A, `AAAx-${RUN}`, "Makes phones and laptops");
    const B = await mkAsset(MINT_B, `BBBx-${RUN}`);
    const C = await mkAsset(MINT_C, `CCCx-${RUN}`);
    assetIds.push(A.id, B.id, C.id);

    // 1. Deck serves both seeded assets; wallets empty; stockConsent false.
    let res: Response = await deck.GET(get("http://x/api/stocks/deck"));
    assert.strictEqual(res.status, 200, "deck 200");
    let body = (await res.json()) as { cards: { id: string; blurb: string | null }[]; wallets: string[]; stockConsent: boolean };
    const ids = new Set(body.cards.map((c) => c.id));
    assert.ok(ids.has(A.id) && ids.has(B.id), "deck serves both seeded assets");
    assert.strictEqual(body.cards.find((c) => c.id === A.id)!.blurb, "Makes phones and laptops", "the card carries the stored blurb");
    assert.strictEqual(body.cards.find((c) => c.id === B.id)!.blurb, null, "an asset with no blurb serves null, not a placeholder");
    assert.deepStrictEqual(body.wallets, [], "no verified wallets");
    assert.strictEqual(body.stockConsent, false, "no stock consent");

    // 1b. The deck is dealt per economy: D is deck-eligible on a reference price but has no Solana
    // pool. Paper mode deals it; real mode never does (every real card must be buyable on chain).
    const D = await prisma.stockAsset.create({
      data: { mint: `mintD-${RUN}`, symbol: `DDDx-${RUN}`, name: "DDDx xStock", underlying: "DDD", decimals: 8, deckEligible: true, priceCents: 1000, liquidityCents: null, pricedAt: new Date() },
      select: { id: true },
    });
    assetIds.push(D.id);
    const dealt = async () => new Set(((await (await deck.GET(get("http://x/api/stocks/deck"))).json()) as { cards: { id: string }[] }).cards.map((c) => c.id));
    assert.ok((await dealt()).has(D.id), "paper mode deals the pool-less asset");
    await prisma.user.update({ where: { id: user.id }, data: { realMode: true, realConsentAt: new Date(), realConsentVersion: REAL_TERMS_VERSION } });
    const realDeal = await dealt();
    assert.ok(!realDeal.has(D.id), "real mode never deals an asset with no on-chain market");
    assert.ok(realDeal.has(A.id) && realDeal.has(B.id), "real mode still deals the tradable ones");
    await prisma.user.update({ where: { id: user.id }, data: { realMode: false } });

    // 2. Buy A: 1000c at 334.16 -> qtyBase 2992578, hold +1000, balance unchanged.
    const R1 = rid();
    res = await buy.POST(post("http://x/api/stocks/buy", { assetId: A.id, stakeCents: 1000, requestId: R1 }));
    assert.strictEqual(res.status, 200, "buy A 200");
    const buyA = (await res.json()) as { positionId: string; qtyBase: string; priceCents: number; costCents: number; alreadyBought: boolean };
    assert.strictEqual(buyA.qtyBase, "2992578", "qtyBase for 1000c at 334.16");
    assert.strictEqual(buyA.priceCents, 33416, "priceCents");
    assert.strictEqual(buyA.costCents, 1000, "costCents");
    assert.strictEqual(buyA.alreadyBought, false, "first buy is not a replay");
    const vb1 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
    assert.strictEqual(vb1.lockedCents, vb0.lockedCents + 1000, "hold +1000");
    assert.strictEqual(vb1.balanceCents, vb0.balanceCents, "balance unchanged");

    // 3. Same body again -> alreadyBought true, same positionId, still ONE lot, hold unchanged.
    res = await buy.POST(post("http://x/api/stocks/buy", { assetId: A.id, stakeCents: 1000, requestId: R1 }));
    assert.strictEqual(res.status, 200, "replay 200");
    const buyA2 = (await res.json()) as { positionId: string; alreadyBought: boolean };
    assert.strictEqual(buyA2.alreadyBought, true, "replay is alreadyBought");
    assert.strictEqual(buyA2.positionId, buyA.positionId, "same lot");
    assert.strictEqual(await prisma.stockPosition.count({ where: { userId: user.id, assetId: A.id } }), 1, "one lot for A");
    const vb2 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
    assert.strictEqual(vb2.lockedCents, vb1.lockedCents, "hold unchanged on replay");

    // 4. Two concurrent buys of B, Cash covers only one (balance = locked + 1500).
    await prisma.virtualBalance.update({
      where: { userId: user.id },
      data: { balanceCents: vb2.lockedCents + 1500 },
    });
    const [r1, r2] = await Promise.all([
      buy.POST(post("http://x/api/stocks/buy", { assetId: B.id, stakeCents: 1000, requestId: rid() })),
      buy.POST(post("http://x/api/stocks/buy", { assetId: B.id, stakeCents: 1000, requestId: rid() })),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [200, 402], "exactly one 200 and one 402");
    assert.strictEqual(await prisma.stockPosition.count({ where: { userId: user.id, assetId: B.id } }), 1, "one lot for B");

    // 5. Deck no longer serves A or B (open lots); pass C -> deck drops C; pass C again -> 200.
    res = await deck.GET(get("http://x/api/stocks/deck"));
    body = (await res.json()) as { cards: { id: string; blurb: string | null }[]; wallets: string[]; stockConsent: boolean };
    const ids2 = new Set(body.cards.map((c) => c.id));
    assert.ok(!ids2.has(A.id) && !ids2.has(B.id), "deck drops open lots");
    res = await pass.POST(post("http://x/api/stocks/pass", { assetId: C.id }));
    assert.strictEqual(res.status, 200, "pass C 200");
    res = await deck.GET(get("http://x/api/stocks/deck"));
    body = (await res.json()) as { cards: { id: string; blurb: string | null }[]; wallets: string[]; stockConsent: boolean };
    assert.ok(!new Set(body.cards.map((c) => c.id)).has(C.id), "deck drops passed C");
    res = await pass.POST(post("http://x/api/stocks/pass", { assetId: C.id }));
    assert.strictEqual(res.status, 200, "pass C again is idempotent");

    // 6. Portfolio: two open lots, totals.paper.costCents 2000, fresh true; then stale A.
    res = await portfolio.GET(get("http://x/api/stocks/portfolio"));
    assert.strictEqual(res.status, 200, "portfolio 200");
    let pf = (await res.json()) as {
      open: { id: string; fresh: boolean }[];
      totals: { paper: { costCents: number } };
    };
    assert.strictEqual(pf.open.length, 2, "two open lots");
    assert.strictEqual(pf.totals.paper.costCents, 2000, "paper cost 2000");
    assert.ok(pf.open.every((r) => r.fresh), "all fresh");
    await prisma.stockAsset.update({
      where: { id: A.id },
      data: { pricedAt: new Date(Date.now() - 20 * 60_000) },
    });
    res = await portfolio.GET(get("http://x/api/stocks/portfolio"));
    pf = (await res.json()) as { open: { id: string; fresh: boolean }[]; totals: { paper: { costCents: number } } };
    const rowA = pf.open.find((r) => r.id === buyA.positionId);
    assert.ok(rowA && !rowA.fresh, "A is stale after 20 min");

    // 7. Sell A at 350.00 -> proceeds 1047, pnl 47; balance +47, locked -1000; second sell 409; random 404.
    priceUsd = 350.0;
    res = await sell.POST(post("http://x/api/stocks/sell", { positionId: buyA.positionId }));
    assert.strictEqual(res.status, 200, "sell A 200");
    const sellA = (await res.json()) as { proceedsCents: number; pnlCents: number };
    assert.strictEqual(sellA.proceedsCents, 1047, "proceeds 1047");
    assert.strictEqual(sellA.pnlCents, 47, "pnl 47");
    const vb3 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
    assert.strictEqual(vb3.balanceCents, vb2.lockedCents + 1500 + 47, "balance +47");
    assert.strictEqual(vb3.lockedCents, vb2.lockedCents + 1000 - 1000, "locked -1000");
    res = await sell.POST(post("http://x/api/stocks/sell", { positionId: buyA.positionId }));
    assert.strictEqual(res.status, 409, "second sell 409");
    res = await sell.POST(post("http://x/api/stocks/sell", { positionId: "nope" }));
    assert.strictEqual(res.status, 404, "unknown lot 404");

    // 8. Bad bodies.
    res = await buy.POST(post("http://x/api/stocks/buy", { assetId: A.id, stakeCents: 50, requestId: rid() }));
    assert.strictEqual(res.status, 400, "stake 50 -> 400");
    res = await buy.POST(post("http://x/api/stocks/buy", { assetId: A.id, stakeCents: 60_000, requestId: rid() }));
    assert.strictEqual(res.status, 400, "stake 60000 -> 400");
    res = await buy.POST(post("http://x/api/stocks/buy", { assetId: A.id, stakeCents: 1000 }));
    assert.strictEqual(res.status, 400, "missing requestId -> 400");
    res = await buy.POST(post("http://x/api/stocks/buy", { assetId: "unknown", stakeCents: 1000, requestId: rid() }));
    assert.strictEqual(res.status, 404, "unknown asset -> 404");

    // 9. Jupiter outage -> 502 price_unavailable, no lot created.
    jupiterDown = true;
    const before = await prisma.stockPosition.count({ where: { userId: user.id } });
    res = await buy.POST(post("http://x/api/stocks/buy", { assetId: C.id, stakeCents: 1000, requestId: rid() }));
    assert.strictEqual(res.status, 502, "Jupiter down -> 502");
    assert.strictEqual(((await res.json()) as { error: string }).error, "price_unavailable", "502 reason");
    assert.strictEqual(await prisma.stockPosition.count({ where: { userId: user.id } }), before, "no lot on outage");
    jupiterDown = false;

    // 10. Blurb fill: writes the assets that have none, NEVER overwrites the one that has.
    const { fillMissingBlurbs } = await import("../src/lib/stock-blurbs");
    assert.deepStrictEqual(await fillMissingBlurbs(prisma, { max: 5 }), { scanned: 0, written: 0, skipped: 0 }, "no key -> no call at all");
    const symB = `BBBx-${RUN}`;
    const symC = `CCCx-${RUN}`;
    blurbReply = {
      [symB]: "Runs cloud data centres.",
      [symC]: `${symC} xStock`, // the name echoed back — must be rejected
      [`AAAx-${RUN}`]: "OVERWRITTEN",
    };
    process.env.NLU_API_KEY = "test-key";
    try {
      await fillMissingBlurbs(prisma, { max: 40, batch: 20 });
    } finally {
      delete process.env.NLU_API_KEY;
    }
    const after = await prisma.stockAsset.findMany({ where: { id: { in: [A.id, B.id, C.id] } }, select: { id: true, blurb: true } });
    const blurbOf = (id: string) => after.find((r) => r.id === id)!.blurb;
    assert.strictEqual(blurbOf(A.id), "Makes phones and laptops", "an existing blurb is never overwritten");
    assert.strictEqual(blurbOf(B.id), "Runs cloud data centres", "a missing blurb is filled, trailing period stripped");
    assert.strictEqual(blurbOf(C.id), null, "the name echoed back is rejected, the row stays null");

    // 11. Public stocks health probe: no auth, no secrets, counts only. 200/503 by fresh deck count.
    const health = await import("../src/app/api/stocks/health/route");
    const hres = await health.GET();
    const hbody = (await hres.json()) as Record<string, unknown>;
    assert.deepStrictEqual(
      Object.keys(hbody).sort(),
      ["assets", "deckFresh", "ok", "oldestFreshAgeSec", "sponsorLamports", "sponsorOk", "stuckAttempts"],
      "/stocks/health keys",
    );
    assert.strictEqual(hres.status, hbody.ok ? 200 : 503, "/stocks/health status follows ok");
    assert.strictEqual(typeof hbody.deckFresh, "number", "deckFresh is a count");

    console.log("test-stocks-db: OK");
  } finally {
    if (userId) {
      const userIds = [userId];
      await prisma.stockPosition.deleteMany({ where: { userId } });
      await prisma.stockPass.deleteMany({ where: { userId } });
      await prisma.stockBuyAttempt.deleteMany({ where: { userId } });
      await prisma.shardGrant.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.bet.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.pointsLedger.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.loginMark.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.dailyCounter.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.streakEvent.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.streak.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.collectibleBalance.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.virtualBalance.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (assetIds.length) await prisma.stockAsset.deleteMany({ where: { id: { in: assetIds } } });
    globalThis.fetch = realFetch;
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
