// Route-level guards the audit flagged as covered only by unit tests, never through the REAL Next
// route handlers (real serialization, real DB, real cross-module wiring). We call the actual
// handlers, stubbing only Privy's network calls (verifyAuthToken/getUser) at the prototype level —
// the same seam test-api-contract.ts uses. Three gaps:
//   (a) OVER-CAP swipe is rejected PRE-WRITE: at the daily cap, swipe #cap+1 returns 403 AND creates
//       no Bet row (the cheap isOverCap gate bails before recordSwipe's transaction — no DB inflation).
//   (b) DECK ANTI-JOIN excludes swiped markets: a market the user has bet never re-appears in /deck
//       (the bets:{none} NOT EXISTS anti-join).
//   (c) REFERRAL live trigger E2E: inviter+invitee, capture via /login-mark?ref=, invitee earns
//       through the REAL routes (10 swipes -> qualifies, + 1 GM tap), and the inviter's REFERRAL
//       ledger grows by floor(20% of the invitee's eligible SWIPE+LOGIN points). This is the wiring
//       the unit tests never exercised (swipe route -> maybeQualifyReferralOnSwipe -> accrual).
//
// Multi-user: unlike test-api-contract (one STUB_DID), the referral E2E needs two distinct identities,
// so the Privy stub maps each Bearer token -> its own DID and getUser returns a per-DID email.
//
// Device guard is intentionally OFF here: we DON'T set REFERRAL_HASH_SECRET, so deviceHashes() is null
// and captureReferral relies purely on the ?ref=<code> path (deterministic, no fingerprint coupling).
// Run: npx tsx scripts/test-route-guards.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";

const RUN = `${process.pid}-${Date.now() & 0xffffff}`;
const did = (label: string) => `did:privy:rg-${RUN}-${label}`;

// token <-> DID registry. Each Bearer token resolves to its own DID; getUser returns a unique email
// per DID so extractIdentity (ensureUser) provisions distinct users. "bad" tokens throw -> 401 path.
const TOKENS: Record<string, string> = {};
(PrivyClient.prototype as any).verifyAuthToken = async (token: string) => {
  const userId = TOKENS[token];
  if (!userId) throw new Error("invalid auth token");
  return { userId };
};
(PrivyClient.prototype as any).getUser = async (privyId: string) => ({
  email: { address: `${privyId}@test.local` }, twitter: null, wallet: null, linkedAccounts: [],
});

// Register a token for a DID and return the authed-Request helper bound to it.
function authAs(token: string, privyId: string) {
  TOKENS[token] = privyId;
  return (url: string, init: RequestInit = {}) =>
    new Request(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { SWIPE_CAP, REFERRAL_INVITER_RATE } = await import("../src/lib/config");
  const me = await import("../src/app/api/me/route");
  const deck = await import("../src/app/api/deck/route");
  const swipe = await import("../src/app/api/swipe/route");
  const loginMark = await import("../src/app/api/login-mark/route");

  const userIds: string[] = []; // for finally cleanup
  const mktPrefix = `rg-${RUN}-mkt`;

  // Seed an OPEN, in-window, contested-band market so /deck serves it and /swipe can hit it. The
  // soon (but >now) deadline puts these first in the deck's resolutionDeadline-asc order so they
  // survive the take:500/DECK_SIZE cut.
  // ponytail: the deck-membership asserts in (b) assume the test DB has few OTHER in-window OPEN
  // markets competing for the 50 deck slots — true for test:db:run, which runs `migrate deploy` on a
  // fresh Docker DB and every sibling test cleans up its own markets. If that stops holding, seed a
  // unique near-term category bucket instead of relying on the soonest-N cut.
  const mkMarket = (label: string) =>
    prisma.market.create({
      data: {
        polymarketId: `${mktPrefix}-${label}`, question: `RG market ${label}?`, status: "OPEN",
        yesPriceBp: 5000, noPriceBp: 5000, resolutionDeadline: new Date(Date.now() + 600_000),
        outcomeYesLabel: "Yes", outcomeNoLabel: "No",
      },
      select: { id: true },
    });

  try {
    // ===================================================================================
    // (a) OVER-CAP swipe rejected PRE-WRITE (no Bet row created on the over-cap attempt)
    // ===================================================================================
    const capDid = did("cap");
    const capAuth = authAs("cap-tok", capDid);
    // Provision via /me, then resolve the app user id.
    assert.strictEqual((await me.GET(capAuth("http://x/api/me"))).status, 200, "(a) /me provisions cap user");
    const capUser = await prisma.user.findUniqueOrThrow({ where: { privyId: capDid } });
    userIds.push(capUser.id);

    // SWIPE_CAP + 1 distinct markets (one bet per market — P2002 otherwise).
    const capMarkets = [];
    for (let i = 0; i <= SWIPE_CAP; i++) capMarkets.push(await mkMarket(`cap-${i}`));

    // Drive exactly SWIPE_CAP successful swipes through the route.
    for (let i = 0; i < SWIPE_CAP; i++) {
      const res = await swipe.POST(capAuth("http://x/api/swipe",
        { method: "POST", body: JSON.stringify({ marketId: capMarkets[i].id, side: "YES" }) }));
      assert.strictEqual(res.status, 200, `(a) swipe ${i} within cap -> 200`);
    }

    // Bet count BEFORE the over-cap attempt = SWIPE_CAP.
    const betsBefore = await prisma.bet.count({ where: { userId: capUser.id } });
    assert.strictEqual(betsBefore, SWIPE_CAP, `(a) ${SWIPE_CAP} bets stored at the cap`);

    // The (cap+1)th swipe via the route -> 403, and NO new Bet row (pre-write reject, no DB inflation).
    const overRes = await swipe.POST(capAuth("http://x/api/swipe",
      { method: "POST", body: JSON.stringify({ marketId: capMarkets[SWIPE_CAP].id, side: "YES" }) }));
    assert.strictEqual(overRes.status, 403, "(a) over-cap swipe -> 403");
    const overBody = await overRes.json();
    assert.ok("error" in overBody, "(a) 403 body has { error }");
    const betsAfter = await prisma.bet.count({ where: { userId: capUser.id } });
    assert.strictEqual(betsAfter, betsBefore, "(a) over-cap attempt created NO extra Bet row (pre-write reject)");
    // And specifically the over-cap market has no bet for this user.
    const overBet = await prisma.bet.findUnique({
      where: { userId_marketId: { userId: capUser.id, marketId: capMarkets[SWIPE_CAP].id } },
    });
    assert.strictEqual(overBet, null, "(a) no Bet row for the over-cap market");

    // ===================================================================================
    // (b) DECK anti-join excludes already-swiped markets (bets:{none} NOT EXISTS)
    // ===================================================================================
    const deckDid = did("deck");
    const deckAuth = authAs("deck-tok", deckDid);
    assert.strictEqual((await me.GET(deckAuth("http://x/api/me"))).status, 200, "(b) /me provisions deck user");
    const deckUser = await prisma.user.findUniqueOrThrow({ where: { privyId: deckDid } });
    userIds.push(deckUser.id);

    const swiped = await mkMarket("deck-swiped");
    const fresh = await mkMarket("deck-fresh");

    // Deck BEFORE swiping: both seeded markets are servable.
    const ids = (body: any) => new Set(body.cards.map((c: any) => c.id));
    const before = ids(await (await deck.GET(deckAuth("http://x/api/deck"))).json());
    assert.ok(before.has(swiped.id), "(b) to-be-swiped market is in the deck before swiping");
    assert.ok(before.has(fresh.id), "(b) the fresh market is in the deck");

    // Swipe one market via the real route.
    const sw = await swipe.POST(deckAuth("http://x/api/swipe",
      { method: "POST", body: JSON.stringify({ marketId: swiped.id, side: "NO" }) }));
    assert.strictEqual(sw.status, 200, "(b) swiping the market -> 200");

    // Deck AFTER: the swiped market is excluded (anti-join), the un-swiped one still served.
    const after = ids(await (await deck.GET(deckAuth("http://x/api/deck"))).json());
    assert.ok(!after.has(swiped.id), "(b) swiped market is EXCLUDED from the deck (bets:{none} anti-join)");
    assert.ok(after.has(fresh.id), "(b) un-swiped market is still served");

    // ===================================================================================
    // (c) REFERRAL live trigger E2E through the real routes
    // ===================================================================================
    const inviterDid = did("inviter");
    const inviteeDid = did("invitee");
    const inviterAuth = authAs("inviter-tok", inviterDid);
    const inviteeAuth = authAs("invitee-tok", inviteeDid);

    // Provision both; inviter first so it owns a referralCode the invitee can capture with.
    assert.strictEqual((await me.GET(inviterAuth("http://x/api/me"))).status, 200, "(c) /me provisions inviter");
    assert.strictEqual((await me.GET(inviteeAuth("http://x/api/me"))).status, 200, "(c) /me provisions invitee");
    const inviter = await prisma.user.findUniqueOrThrow({ where: { privyId: inviterDid } });
    const invitee = await prisma.user.findUniqueOrThrow({ where: { privyId: inviteeDid } });
    userIds.push(inviter.id, invitee.id);

    // Capture the referral via the REAL /login-mark?ref=<inviterCode> (also the invitee's GM tap =
    // +1 LOGIN point). captureReferral binds inviter->invitee (device guard off, ?ref path only).
    const gm = await loginMark.POST(inviteeAuth(`http://x/api/login-mark?ref=${inviter.referralCode}`, { method: "POST" }));
    assert.strictEqual(gm.status, 200, "(c) invitee GM tap with ?ref -> 200");
    const refRow = await prisma.referral.findUnique({ where: { inviteeId: invitee.id } });
    assert.ok(refRow, "(c) referral bound (inviter -> invitee) via the route");
    assert.strictEqual(refRow!.inviterId, inviter.id, "(c) referral inviter is correct");

    // Invitee earns SWIPE_CAP swipes through the real route — the 10th qualifies the referral
    // (maybeQualifyReferralOnSwipe fires from inside the swipe handler) and triggers accrual.
    const inviteeMarkets = [];
    for (let i = 0; i < SWIPE_CAP; i++) inviteeMarkets.push(await mkMarket(`inv-${i}`));
    for (let i = 0; i < SWIPE_CAP; i++) {
      const res = await swipe.POST(inviteeAuth("http://x/api/swipe",
        { method: "POST", body: JSON.stringify({ marketId: inviteeMarkets[i].id, side: "YES" }) }));
      assert.strictEqual(res.status, 200, `(c) invitee swipe ${i} -> 200`);
    }

    // The referral is now qualified (10 lifetime swipes).
    const qualified = await prisma.referral.findUnique({ where: { inviteeId: invitee.id }, select: { qualifiedAt: true } });
    assert.ok(qualified?.qualifiedAt, "(c) referral qualified after 10 swipes through the route");

    // Eligible raw = the invitee's SWIPE + LOGIN points (the inviterEligibleTypes). 10 swipes + 1 GM.
    const eligible = await prisma.pointsLedger.aggregate({
      where: { userId: invitee.id, type: { in: ["SWIPE", "LOGIN"] } }, _sum: { amount: true },
    });
    const eligibleRaw = eligible._sum.amount ?? 0;
    assert.strictEqual(eligibleRaw, SWIPE_CAP + 1, `(c) invitee eligible raw = ${SWIPE_CAP} swipe + 1 login`);

    // The inviter's REFERRAL ledger = floor(eligibleRaw * rate) — the live accrual through the routes.
    const inviterReferral = await prisma.pointsLedger.aggregate({
      where: { userId: inviter.id, type: "REFERRAL" }, _sum: { amount: true },
    });
    const expectedInviter = Math.floor(eligibleRaw * REFERRAL_INVITER_RATE);
    assert.strictEqual(inviterReferral._sum.amount ?? 0, expectedInviter,
      `(c) inviter REFERRAL ledger = floor(${eligibleRaw} * ${REFERRAL_INVITER_RATE}) = ${expectedInviter}`);
    assert.ok(expectedInviter > 0, "(c) sanity: the eligible total is large enough to pay a non-zero share");

    // ===================================================================================
    // (d) FRESHNESS guard: a swipe on a market within the lead cutoff (<5min) -> 409 market_expired
    //     and NO Bet row; the deck route also won't serve such a market (lower-bound filter).
    // ===================================================================================
    const expDid = did("expire");
    const expAuth = authAs("expire-tok", expDid);
    assert.strictEqual((await me.GET(expAuth("http://x/api/me"))).status, 200, "(d) /me provisions user");
    const expUser = await prisma.user.findUniqueOrThrow({ where: { privyId: expDid } });
    userIds.push(expUser.id);
    const expiring = await prisma.market.create({
      data: {
        polymarketId: `${mktPrefix}-expiring`, question: "RG expiring?", status: "OPEN",
        yesPriceBp: 5000, noPriceBp: 5000, resolutionDeadline: new Date(Date.now() + 60_000), // ~1 min < lead
        outcomeYesLabel: "Yes", outcomeNoLabel: "No",
      },
      select: { id: true },
    });
    const expRes = await swipe.POST(expAuth("http://x/api/swipe",
      { method: "POST", body: JSON.stringify({ marketId: expiring.id, side: "YES" }) }));
    assert.strictEqual(expRes.status, 409, "(d) swipe within the lead cutoff -> 409");
    assert.strictEqual((await expRes.json()).error, "market_expired", "(d) 409 reason = market_expired");
    assert.strictEqual(await prisma.bet.count({ where: { userId: expUser.id } }), 0, "(d) no Bet row for the expiring market");
    const dIds = new Set(((await (await deck.GET(expAuth("http://x/api/deck"))).json()).cards as { id: string }[]).map((c) => c.id));
    assert.ok(!dIds.has(expiring.id), "(d) deck route excludes the <lead market (lower-bound filter)");

    console.log(
      `OK: route guards — (a) over-cap 403 + 0 extra bets; (b) deck anti-join excludes swiped; ` +
      `(c) referral E2E pays inviter ${expectedInviter} (20% of ${eligibleRaw}); (d) <lead market -> 409 + not served`,
    );
  } finally {
    // Clean up everything this run created, children before parents, even on assertion failure
    // (addresses the leaked-rows hygiene note). Scoped to this run's tag / user ids.
    const refIds = (await prisma.referral.findMany({
      where: { OR: [{ inviterId: { in: userIds } }, { inviteeId: { in: userIds } }] }, select: { id: true },
    })).map((r) => r.id);
    await prisma.referralEvent.deleteMany({ where: { referralId: { in: refIds } } });
    await prisma.referral.deleteMany({ where: { id: { in: refIds } } });
    await prisma.shardGrant.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.bet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.pointsLedger.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.loginMark.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.dailyCounter.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.streakEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.streak.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.collectibleBalance.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.virtualBalance.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.market.deleteMany({ where: { polymarketId: { startsWith: mktPrefix } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
