// (7) API CONTRACT — the response SHAPE Android binds to must not silently drift. For every route:
//   (a) no token -> 401 { error }   (the auth gate, real)
//   (b) valid token -> 200 with EXACTLY the documented top-level keys (pins the contract)
// We call the real Next route handlers (real serialization, real DB), stubbing only the one Privy
// network call (verifyAuthToken/getUser) at the prototype level — the same seam as test-auth.
// If a route adds/removes/renames a top-level key, this test fails: that's the point.
// Run: npx tsx scripts/test-api-contract.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";

const STUB_DID = `did:privy:apitest-${process.pid}-${Date.now() & 0xffffff}`;
(PrivyClient.prototype as any).verifyAuthToken = async (token: string) => {
  if (token === "good") return { userId: STUB_DID };
  throw new Error("invalid auth token");
};
(PrivyClient.prototype as any).getUser = async () => ({
  email: { address: `${STUB_DID}@test.local` }, twitter: null, wallet: null, linkedAccounts: [],
});

const TOKEN = "Bearer good";
const req = (url: string, init?: RequestInit) => new Request(url, init);
const authed = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { ...(init.headers ?? {}), authorization: TOKEN } });

// Sorted top-level keys of a JSON response body.
const keysOf = (o: object) => Object.keys(o).sort();

async function expect401(handler: (r: Request) => Promise<Response>, url: string, init?: RequestInit) {
  const res = await handler(req(url, init));
  assert.strictEqual(res.status, 401, `${url} without token -> 401 (got ${res.status})`);
  const body = await res.json();
  assert.ok("error" in body, `${url} 401 body has { error }`);
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");

  // Import route handlers (after the stub is in place).
  const me = await import("../src/app/api/me/route");
  const deck = await import("../src/app/api/deck/route");
  const swipe = await import("../src/app/api/swipe/route");
  const skip = await import("../src/app/api/skip/route");
  const recover = await import("../src/app/api/recover/route");
  const topup = await import("../src/app/api/topup/route");
  const history = await import("../src/app/api/history/route");
  const loginMark = await import("../src/app/api/login-mark/route");
  const results = await import("../src/app/api/results/route");
  const resultsSeen = await import("../src/app/api/results/seen/route");
  const captureRef = await import("../src/app/api/capture-ref/route");

  // Provision the test user via /me (which calls authUser -> ensureUser).
  const meRes = await me.GET(authed("http://x/api/me"));
  assert.strictEqual(meRes.status, 200, "authed /me -> 200");
  const user = await prisma.user.findUniqueOrThrow({ where: { privyId: STUB_DID } });

  // Seed one OPEN, tradable, in-window market so /deck returns a card and /swipe can hit it.
  const market = await prisma.market.create({
    data: {
      polymarketId: `apitest-${process.pid}-mkt`, question: "Contract test market?", status: "OPEN",
      yesPriceBp: 5000, noPriceBp: 5000, resolutionDeadline: new Date(Date.now() + 3_600_000),
      outcomeYesLabel: "Yes", outcomeNoLabel: "No",
    },
  });

  // ---- (a) every route 401s without a token ----
  await expect401(me.GET, "http://x/api/me");
  await expect401(deck.GET, "http://x/api/deck");
  await expect401(history.GET, "http://x/api/history");
  await expect401(swipe.POST, "http://x/api/swipe", { method: "POST", body: "{}" });
  await expect401(skip.POST, "http://x/api/skip", { method: "POST" });
  await expect401(recover.POST, "http://x/api/recover", { method: "POST" });
  await expect401(topup.POST, "http://x/api/topup", { method: "POST", body: "{}" });
  await expect401(loginMark.POST, "http://x/api/login-mark", { method: "POST" });
  await expect401(results.GET, "http://x/api/results");
  await expect401(resultsSeen.POST, "http://x/api/results/seen", { method: "POST" });
  await expect401(captureRef.POST, "http://x/api/capture-ref", { method: "POST" });

  // ---- (b) authed 200 + EXACT top-level key contract (Android binds to these) ----
  const meBody = await (await me.GET(authed("http://x/api/me"))).json();
  assert.deepStrictEqual(keysOf(meBody),
    ["artifacts","balanceCents","cashCents","dev","isNewUser","lockedCents","loginMarkedToday","points","shards","shardsPerArtifact","skips","stakeCents","streak","swipes","topup","unreadResults","user"],
    "/me top-level keys");
  assert.deepStrictEqual(Object.keys(meBody.points).sort(), ["bonusFromX2","breakdown","total"], "/me points keys");
  assert.deepStrictEqual(Object.keys(meBody.swipes).sort(), ["cap","used"], "/me swipes keys");
  assert.deepStrictEqual(Object.keys(meBody.topup).sort(),
    ["artifactCost","artifactTopupAvailable","freeTopupAvailable","freeTopupUsed","grantCents"], "/me topup keys");
  assert.deepStrictEqual(Object.keys(meBody.streak).sort(),
    ["level","recoverableUntil","state","todayWeekday","windowStartWeekday"], "/me streak keys");

  const deckBody = await (await deck.GET(authed("http://x/api/deck"))).json();
  assert.deepStrictEqual(keysOf(deckBody), ["cards"], "/deck top-level keys");
  assert.ok(Array.isArray(deckBody.cards), "/deck cards is an array");
  if (deckBody.cards.length) {
    assert.deepStrictEqual(Object.keys(deckBody.cards[0]).sort(),
      ["category","id","noPriceBp","outcomeNoLabel","outcomeYesLabel","question","resolutionDeadline","yesPriceBp"],
      "/deck card keys");
  }

  const histBody = await (await history.GET(authed("http://x/api/history"))).json();
  assert.deepStrictEqual(keysOf(histBody), ["pendingCount","rows"], "/history top-level keys");

  // login-mark: GM tap response contract.
  const gmBody = await (await loginMark.POST(authed("http://x/api/login-mark", { method: "POST" }))).json();
  assert.deepStrictEqual(keysOf(gmBody), ["login","streak"], "/login-mark top-level keys");
  assert.deepStrictEqual(Object.keys(gmBody.login).sort(), ["amount","awarded"], "/login-mark login keys");
  assert.deepStrictEqual(Object.keys(gmBody.streak).sort(), ["level","qualifiedToday","state"], "/login-mark streak keys");

  // capture-ref: referral-only (no GM mark). Shape is { captured }. No ?ref= -> captured:false.
  const crBody = await (await captureRef.POST(authed("http://x/api/capture-ref", { method: "POST" }))).json();
  assert.deepStrictEqual(keysOf(crBody), ["captured"], "/capture-ref top-level keys");
  assert.strictEqual(crBody.captured, false, "/capture-ref no code -> not captured");

  // swipe: a real authed swipe returns the recordSwipe contract.
  const swBody = await (await swipe.POST(authed("http://x/api/swipe",
    { method: "POST", body: JSON.stringify({ marketId: market.id, side: "YES" }) }))).json();
  assert.deepStrictEqual(keysOf(swBody), ["betId","overCap","pointsAwarded","swipeCountToday"], "/swipe top-level keys");

  // swipe bad input -> 400 { error } (input validation contract).
  const badSwipe = await swipe.POST(authed("http://x/api/swipe", { method: "POST", body: "{}" }));
  assert.strictEqual(badSwipe.status, 400, "/swipe missing fields -> 400");

  // skip: first skip free -> 200 (recordSkip contract — just assert it's an object with `ok`).
  const skipRes = await skip.POST(authed("http://x/api/skip", { method: "POST" }));
  const skipBody = await skipRes.json();
  assert.ok("ok" in skipBody, "/skip body has `ok`");

  // recover: not in a recoverable state -> 409 { recovered:false, ... }.
  const recRes = await recover.POST(authed("http://x/api/recover", { method: "POST" }));
  assert.strictEqual(recRes.status, 409, "/recover with no burned streak -> 409");
  const recBody = await recRes.json();
  assert.strictEqual(recBody.recovered, false, "/recover body recovered=false");

  // topup: bad/missing kind -> 400; dormant points path -> 404 (route hides it); artifact w/ none -> 402.
  const badTopup = await topup.POST(authed("http://x/api/topup", { method: "POST", body: "{}" }));
  assert.strictEqual(badTopup.status, 400, "/topup missing kind -> 400");
  const ptsTopup = await topup.POST(authed("http://x/api/topup", { method: "POST", body: JSON.stringify({ kind: "points" }) }));
  assert.strictEqual(ptsTopup.status, 404, "/topup dormant points path -> 404");
  const artTopup = await topup.POST(authed("http://x/api/topup", { method: "POST", body: JSON.stringify({ kind: "artifact" }) }));
  assert.strictEqual(artTopup.status, 402, "/topup artifact with no artifact -> 402");

  // results: empty top-level contract first (no settled bets yet).
  const resEmpty = await (await results.GET(authed("http://x/api/results"))).json();
  assert.deepStrictEqual(keysOf(resEmpty), ["rows","unreadCount"], "/results top-level keys");
  assert.strictEqual(resEmpty.rows.length, 0, "/results no settled bets yet -> empty");

  // Settle the swiped bet (resolve market YES) so /results returns a real ResultRow.
  const { settleMarket } = await import("./settle");
  await settleMarket(prisma, market.id, { kind: "resolved", resolvedYes: true });

  const resBody = await (await results.GET(authed("http://x/api/results"))).json();
  assert.strictEqual(resBody.rows.length, 1, "/results one settled bet -> one row");
  assert.strictEqual(resBody.unreadCount, 1, "/results unread before seen = 1");
  assert.deepStrictEqual(Object.keys(resBody.rows[0]).sort(),
    ["category","deltaCents","id","outcome","pnlCents","question","seen","settledAt","shards","side","sideLabel","status"],
    "/results row keys");
  assert.strictEqual(resBody.rows[0].status, "WIN", "/results YES bet on YES resolution = WIN");
  assert.strictEqual(resBody.rows[0].seen, false, "/results row unseen before /seen");

  // /me reflects the unread before it's marked seen.
  const meUnread = await (await me.GET(authed("http://x/api/me"))).json();
  assert.strictEqual(meUnread.unreadResults, 1, "/me unreadResults = 1 before seen");

  // results/seen: marks all unseen, idempotent.
  const seen1 = await (await resultsSeen.POST(authed("http://x/api/results/seen", { method: "POST" }))).json();
  assert.deepStrictEqual(keysOf(seen1), ["markedSeen"], "/results/seen top-level keys");
  assert.strictEqual(seen1.markedSeen, 1, "/results/seen marks the 1 unseen row");
  const seen2 = await (await resultsSeen.POST(authed("http://x/api/results/seen", { method: "POST" }))).json();
  assert.strictEqual(seen2.markedSeen, 0, "/results/seen idempotent -> 0 on second call");

  const resAfter = await (await results.GET(authed("http://x/api/results"))).json();
  assert.strictEqual(resAfter.unreadCount, 0, "/results unread after seen = 0");
  assert.strictEqual(resAfter.rows[0].seen, true, "/results row seen=true after /seen");
  const meSeen = await (await me.GET(authed("http://x/api/me"))).json();
  assert.strictEqual(meSeen.unreadResults, 0, "/me unreadResults = 0 after seen");

  // cleanup (children before parents)
  await prisma.shardGrant.deleteMany({ where: { userId: user.id } });
  await prisma.bet.deleteMany({ where: { userId: user.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
  await prisma.loginMark.deleteMany({ where: { userId: user.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
  await prisma.streakEvent.deleteMany({ where: { userId: user.id } });
  await prisma.streak.deleteMany({ where: { userId: user.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: user.id } });
  await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
  await prisma.market.deleteMany({ where: { polymarketId: { startsWith: `apitest-${process.pid}-mkt` } } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();

  console.log("OK: API contract pinned — every route 401s unauthed; authed bodies match documented key-sets");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
