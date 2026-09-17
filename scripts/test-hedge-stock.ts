// DB-backed end-to-end check for the stock hedge cards (S3-stock + spotted) through the REAL route
// handlers with a Privy prototype stub. Seeds the REAL hedge symbols (the rule table points at real
// tickers), then asserts:
//   - search "spending $800 on flights" -> a DALx S3-stock card, sized 10%, with the exact rationale
//   - accept -> a PAPER StockPosition (source HEDGE) + its ACCEPT telemetry in one transaction
//   - re-accept -> idempotent (same lot, alreadyAccepted)
//   - search with amountCents -> XOMx driving card sized off the stated amount
//   - spotted -> the XLEx trigger card, sized off the persisted driving LifeSituation
//   - a no-rule query keeps the S2 shape (isDiscovery boolean, suggestions array)
//   - the stake clamps down to Cash; below the floor -> 402
//   - a stale DALx falls through to the next offered ticker (LUVx; UALx is halted)
// Needs DATABASE_URL (Docker DB). Run: npx tsx scripts/test-hedge-stock.ts
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import { REAL_TERMS_VERSION } from "../src/lib/real-terms";

const RUN = `${process.pid}-${Date.now() & 0xffffff}`;
const DID = `did:privy:stkhedge-${RUN}`;

// The REAL hedge symbols the rule table points at. The test DB is disposable: any pre-existing rows
// with these symbols are deleted first (a dev DB gets them back on the next catalog refresh).
const SYMBOLS = ["DALx", "XOMx", "XLEx", "GLDx", "UALx", "SBUXx", "LUVx"] as const;

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
  const me = await import("../src/app/api/me/route");
  const search = await import("../src/app/api/hedge/search/route");
  const suggestions = await import("../src/app/api/hedge/suggestions/route");
  const spotted = await import("../src/app/api/hedge/spotted/route");
  const accept = await import("../src/app/api/hedge/accept/route");

  // This suite DELETES every asset, position, pass and attempt for seven REAL tickers. On a
  // disposable CI database that is housekeeping; pointed at a dev database it wipes the owner's real
  // catalog and their positions on it (it did, twice, on 2026-09-15). A real catalog row carries the
  // on-chain mint; this suite's fixtures carry "<SYMBOL>-mint-<run>". So: any real row present and
  // no explicit "this DB is disposable" flag -> refuse to run at all.
  const realRows = await prisma.stockAsset.count({
    where: { symbol: { in: [...SYMBOLS] }, NOT: { mint: { contains: "-mint-" } } },
  });
  if (realRows > 0 && process.env.HF_TEST_DB !== "1") {
    console.error(
      `test-hedge-stock: REFUSING to run — this database holds ${realRows} REAL stock_assets row(s) for ${SYMBOLS.join(", ")} ` +
        "and the suite would delete them (with every position on them). Point DATABASE_URL at a disposable test DB, " +
        "or set HF_TEST_DB=1 if you really mean this one.",
    );
    process.exit(2);
  }

  const headers = { authorization: "Bearer good", "content-type": "application/json" };
  const get = (url: string) => new Request(url, { headers });
  const post = (url: string, body: unknown) =>
    new Request(url, { method: "POST", headers, body: JSON.stringify(body) });

  let userId: string | null = null;

  try {
    // Provision the user via /api/me (the stub creates it), then read its VirtualBalance ($200 Cash).
    assert.strictEqual((await me.GET(get("http://x/api/me"))).status, 200, "me provisions user");
    const user = await prisma.user.findUniqueOrThrow({ where: { privyId: DID } });
    userId = user.id;
    const vb0 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
    assert.strictEqual(vb0.balanceCents, 20_000, "start balance $200");
    assert.strictEqual(vb0.lockedCents, 0, "start locked 0");

    // Seed the REAL hedge symbols (positions on them first, then the rows).
    await prisma.stockPosition.deleteMany({ where: { asset: { symbol: { in: [...SYMBOLS] } } } });
    await prisma.stockPass.deleteMany({ where: { asset: { symbol: { in: [...SYMBOLS] } } } });
    await prisma.stockBuyAttempt.deleteMany({ where: { asset: { symbol: { in: [...SYMBOLS] } } } });
    await prisma.stockAsset.deleteMany({ where: { symbol: { in: [...SYMBOLS] } } });
    const now = new Date();
    const mkAsset = (symbol: string, priceCents: number, extra: Record<string, unknown> = {}) =>
      prisma.stockAsset.create({
        data: {
          mint: `${symbol}-mint-${RUN}`,
          symbol,
          name: `${symbol} xStock`,
          underlying: symbol.replace(/x$/, ""),
          decimals: 8,
          priceCents,
          pricedAt: now,
          ...extra,
        },
        select: { id: true },
      });
    const DAL = await mkAsset("DALx", 7958);
    await mkAsset("XOMx", 16589);
    await mkAsset("XLEx", 6500, { change24hBp: 620 });
    await mkAsset("GLDx", 39524, { liquidityCents: 42_000_000 });
    await mkAsset("UALx", 0, { halted: true });
    await mkAsset("SBUXx", 9900);
    await mkAsset("LUVx", 10000);

    // 1. Search "spending $800 on flights this month" -> a DALx S3-stock card.
    let res: Response = await search.POST(post("http://x/api/hedge/search", { text: "spending $800 on flights this month" }));
    assert.strictEqual(res.status, 200, "search 200");
    let body = (await res.json()) as {
      stockSuggestions: { stock: { symbol: string }; proposedStakeCents: number; rationale: string; kind: string; suggestionId: string }[];
      situation: { category: string; amountCents: number } | null;
      isDiscovery: boolean;
    };
    assert.ok(body.stockSuggestions.length >= 1, "at least one stock suggestion");
    const dalCard = body.stockSuggestions[0]!;
    assert.strictEqual(dalCard.stock.symbol, "DALx", "first offered travel ticker is DALx");
    assert.strictEqual(dalCard.proposedStakeCents, 8000, "10% of $800");
    assert.strictEqual(dalCard.rationale, "You're spending $800 on flights this month. Hedge your travel costs with DALx.", "exact rationale");
    assert.strictEqual(dalCard.kind, "S3-stock", "kind S3-stock");
    assert.strictEqual(body.situation?.category, "travel", "situation category travel");
    assert.strictEqual(body.situation?.amountCents, 80000, "situation amount 80000");

    // 1b. Real mode offers only assets with an on-chain market. No travel ticker has a pool here, so
    // the same search yields NO travel card — never a paper one dressed as a hedge.
    await prisma.user.update({ where: { id: userId }, data: { realMode: true, realConsentAt: new Date(), realConsentVersion: REAL_TERMS_VERSION } });
    res = await search.POST(post("http://x/api/hedge/search", { text: "spending $800 on flights this month" }));
    assert.strictEqual(res.status, 200, "real-mode search 200");
    const realBody = (await res.json()) as { stockSuggestions: { stock: { symbol: string } }[] };
    assert.deepStrictEqual(realBody.stockSuggestions.map((c) => c.stock.symbol), [], "real mode: a rule with no on-chain ticker yields no card");
    await prisma.user.update({ where: { id: userId }, data: { realMode: false } });
    assert.strictEqual(body.isDiscovery, false, "not discovery");
    const lifeRow = await prisma.lifeSituation.findUniqueOrThrow({ where: { userId_category: { userId: user.id, category: "travel" } } });
    assert.strictEqual(lifeRow.amountCents, 80000, "LifeSituation amount 80000");
    assert.strictEqual(lifeRow.period, "month", "LifeSituation period month");

    // 2. Accept the DALx card -> a PAPER StockPosition (source HEDGE) + ACCEPT telemetry.
    const sid = dalCard.suggestionId;
    res = await accept.POST(post("http://x/api/hedge/accept", { suggestionId: sid }));
    assert.strictEqual(res.status, 200, "accept 200");
    const acc = (await res.json()) as { betId: string | null; stakeCents: number; alreadyAccepted: boolean; positionId?: string };
    assert.strictEqual(acc.betId, null, "stock accept has no betId");
    assert.strictEqual(acc.stakeCents, 8000, "accepted at 8000");
    assert.strictEqual(acc.alreadyAccepted, false, "first accept is fresh");
    assert.ok(acc.positionId, "positionId returned");
    const lot = await prisma.stockPosition.findUniqueOrThrow({ where: { id: acc.positionId! } });
    assert.strictEqual(lot.source, "HEDGE", "lot source HEDGE");
    assert.strictEqual(lot.mode, "PAPER", "lot mode PAPER");
    assert.strictEqual(lot.hedgeSuggestionId, sid, "lot back-references the suggestion");
    assert.strictEqual(lot.costCents, 8000, "lot cost 8000");
    assert.strictEqual(lot.assetId, DAL.id, "lot asset is DALx");
    const vb1 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
    assert.strictEqual(vb1.lockedCents, vb0.lockedCents + 8000, "hold +8000");
    const evt = await prisma.hedgeSuggestionEvent.findUniqueOrThrow({
      where: { userId_suggestionId_event: { userId: user.id, suggestionId: sid, event: "ACCEPT" } },
    });
    assert.strictEqual(evt.stockSymbol, "DALx", "ACCEPT telemetry stockSymbol DALx");
    assert.strictEqual(evt.marketId, null, "ACCEPT telemetry marketId null");
    assert.strictEqual(evt.positionId, lot.id, "ACCEPT telemetry positionId = lot id");

    // 3. Accept again -> idempotent, same lot, one lot.
    res = await accept.POST(post("http://x/api/hedge/accept", { suggestionId: sid }));
    assert.strictEqual(res.status, 200, "re-accept 200");
    const acc2 = (await res.json()) as { alreadyAccepted: boolean; positionId?: string };
    assert.strictEqual(acc2.alreadyAccepted, true, "re-accept idempotent");
    assert.strictEqual(acc2.positionId, lot.id, "same lot");
    assert.strictEqual(await prisma.stockPosition.count({ where: { userId: user.id, hedgeSuggestionId: sid } }), 1, "one lot");

    // 4. Search "I drive to work every day" with amountCents 20000 -> XOMx, sized 10% of $200.
    res = await search.POST(post("http://x/api/hedge/search", { text: "I drive to work every day", amountCents: 20000 }));
    assert.strictEqual(res.status, 200, "driving search 200");
    body = (await res.json()) as typeof body;
    assert.strictEqual(body.stockSuggestions[0]!.stock.symbol, "XOMx", "first offered driving ticker is XOMx");
    assert.strictEqual(body.stockSuggestions[0]!.proposedStakeCents, 2000, "10% of $200");

    // 5. Spotted -> the XLEx trigger card, sized off the driving LifeSituation.
    res = await spotted.GET(get("http://x/api/hedge/spotted"));
    assert.strictEqual(res.status, 200, "spotted 200");
    const sp = (await res.json()) as {
      suggestions: { stock: { symbol: string }; kind: string; triggerChangeBp: number; rationale: string; proposedStakeCents: number; suggestionId: string }[];
      generatedAt: string;
    };
    assert.strictEqual(sp.suggestions.length, 1, "exactly one spotted card");
    const spCard = sp.suggestions[0]!;
    assert.strictEqual(spCard.stock.symbol, "XOMx", "spotted card is XOMx");
    assert.strictEqual(spCard.kind, "spotted", "spotted kind");
    assert.strictEqual(spCard.triggerChangeBp, 620, "trigger change 620");
    assert.ok(spCard.rationale.startsWith("Energy stocks just jumped +6.2%"), `spotted rationale prefix: ${spCard.rationale}`);
    assert.strictEqual(spCard.proposedStakeCents, 2000, "spotted sized off the driving situation");
    res = await accept.POST(post("http://x/api/hedge/accept", { suggestionId: spCard.suggestionId }));
    assert.strictEqual(res.status, 200, "spotted accept 200");
    const spAcc = (await res.json()) as { positionId?: string };
    assert.ok(spAcc.positionId, "spotted accept returns a positionId");
    const spLot = await prisma.stockPosition.findUniqueOrThrow({ where: { id: spAcc.positionId! } });
    assert.strictEqual(spLot.source, "HEDGE", "spotted lot source HEDGE");

    // 6. A no-rule query keeps the S2 shape.
    res = await search.POST(post("http://x/api/hedge/search", { text: "I'm rooting for the Lakers" }));
    assert.strictEqual(res.status, 200, "lakers search 200");
    const lakers = (await res.json()) as { stockSuggestions: unknown[]; isDiscovery: boolean; suggestions: unknown[] };
    assert.deepStrictEqual(lakers.stockSuggestions, [], "no stock suggestions for a team query");
    assert.strictEqual(typeof lakers.isDiscovery, "boolean", "isDiscovery boolean");
    assert.ok(Array.isArray(lakers.suggestions), "suggestions array");

    // 7. Cash clamp: Cash = 500 -> a fresh $500 flights card accepts at 500; Cash = 50 -> 402.
    const vbPre7 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } }); // the spotted accept added its own hold
    await prisma.virtualBalance.update({ where: { userId: user.id }, data: { balanceCents: vbPre7.lockedCents + 500 } });
    res = await search.POST(post("http://x/api/hedge/search", { text: "$500 on flights this month" }));
    assert.strictEqual(res.status, 200, "clamp search 200");
    const clampBody = (await res.json()) as { stockSuggestions: { suggestionId: string }[] };
    res = await accept.POST(post("http://x/api/hedge/accept", { suggestionId: clampBody.stockSuggestions[0]!.suggestionId }));
    assert.strictEqual(res.status, 200, "clamped accept 200");
    assert.strictEqual(((await res.json()) as { stakeCents: number }).stakeCents, 500, "stake clamped to Cash 500");

    const vbNow = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
    await prisma.virtualBalance.update({ where: { userId: user.id }, data: { balanceCents: vbNow.lockedCents + 50 } });
    res = await search.POST(post("http://x/api/hedge/search", { text: "$300 on flights this month" }));
    assert.strictEqual(res.status, 200, "low-cash search 200");
    const lowBody = (await res.json()) as { stockSuggestions: { suggestionId: string }[] };
    res = await accept.POST(post("http://x/api/hedge/accept", { suggestionId: lowBody.stockSuggestions[0]!.suggestionId }));
    assert.strictEqual(res.status, 402, "below floor -> 402");
    assert.strictEqual(((await res.json()) as { error: string }).error, "insufficient_funds", "402 reason");

    // 8. Make DALx stale -> the travel card falls through to LUVx (UALx is halted).
    await prisma.stockAsset.update({ where: { id: DAL.id }, data: { pricedAt: new Date(Date.now() - 60 * 60_000) } });
    res = await search.POST(post("http://x/api/hedge/search", { text: "$900 on flights" }));
    assert.strictEqual(res.status, 200, "stale search 200");
    const staleBody = (await res.json()) as { stockSuggestions: { stock: { symbol: string } }[] };
    assert.strictEqual(staleBody.stockSuggestions[0]!.stock.symbol, "LUVx", "stale DALx falls through to LUVx");

    // 9. Suggestions route still serves (market-only list; stock cards split out).
    res = await suggestions.GET(get("http://x/api/hedge/suggestions"));
    assert.strictEqual(res.status, 200, "suggestions 200");
    const sugBody = (await res.json()) as { suggestions: unknown[]; walletLinked: boolean; stockSuggestions?: unknown[] };
    assert.strictEqual(sugBody.walletLinked, false, "no wallet linked");
    assert.ok(Array.isArray(sugBody.suggestions), "suggestions array");
    assert.ok(Array.isArray(sugBody.stockSuggestions), "stockSuggestions array");

    console.log("test-hedge-stock: OK");
  } finally {
    if (userId) {
      const userIds = [userId];
      await prisma.stockPosition.deleteMany({ where: { userId } });
      await prisma.hedgeSuggestionEvent.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.lifeSituation.deleteMany({ where: { userId: { in: userIds } } });
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
    await prisma.stockAsset.deleteMany({ where: { symbol: { in: [...SYMBOLS] }, mint: { endsWith: `-mint-${RUN}` } } });
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
