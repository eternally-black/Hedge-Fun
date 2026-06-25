// Live verification of the Polymarket Gamma integration. Run: npm run verify:polymarket
// Hits the real API and asserts the blueprint's VERIFY-AT-RUNTIME flags hold.
import assert from "node:assert";
import { fetchBlitzDeck, fetchResolution, mapMarket } from "../src/lib/polymarket";

// Minimal Gamma GET for the verify-only positive check (gammaGet isn't exported from the lib).
const VERIFY_BASE = process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com";
async function gammaGetForVerify(path: string): Promise<Array<{ conditionId?: string; umaResolutionStatus?: string; outcomePrices?: string }>> {
  const res = await fetch(`${VERIFY_BASE}${path}`, { cache: "no-store", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Gamma ${res.status} for ${path}`);
  return res.json();
}

async function main() {
  console.log("1. fetchBlitzDeck(24)...");
  const deck = await fetchBlitzDeck(24, 50);
  console.log(`   got ${deck.length} blitz markets (<=24h, OPEN, both prices present)`);

  if (deck.length > 0) {
    const c = deck[0];
    console.log("   sample:", {
      id: c.polymarketId.slice(0, 12) + "...",
      q: c.question.slice(0, 60),
      yesBp: c.yesPriceBp,
      noBp: c.noPriceBp,
      deadline: c.resolutionDeadline,
    });
    // Invariants.
    assert.ok(c.polymarketId.startsWith("0x"), "conditionId looks like an on-chain id");
    assert.ok(
      c.yesPriceBp! >= 0 && c.yesPriceBp! <= 10000,
      "yes price in bp range",
    );
    const maxMs = Date.now() + 24 * 3_600_000;
    assert.ok(new Date(c.resolutionDeadline).getTime() <= maxMs, "<=24h window holds");
    // Yes/No price pair should roughly sum to ~1 (10000bp) on a binary market.
    const sum = (c.yesPriceBp ?? 0) + (c.noPriceBp ?? 0);
    assert.ok(Math.abs(sum - 10000) < 1500, `yes+no ~ 10000bp (got ${sum})`);
    console.log("   ✓ blitz invariants hold");

    // Contested-price gate: every returned card must be in the 15%..85% band — no decided/live
    // matches (the ~100%/0% cards). This is the real fix; startDate can't tell live from future.
    for (const card of deck) {
      assert.ok(
        card.yesPriceBp! >= 1500 && card.yesPriceBp! <= 8500 &&
          card.noPriceBp! >= 1500 && card.noPriceBp! <= 8500,
        `price gate: ${card.question.slice(0, 40)} is ${card.yesPriceBp}/${card.noPriceBp}bp (decided/lopsided)`,
      );
    }
    console.log("   ✓ every card is contested (15%..85% band, no 100%/0% cards)");

    // fetchResolution is a RESOLUTION lookup — it queries closed=true, so an OPEN deck market
    // correctly returns null (it isn't resolved). This is the fix for the 2026-06-25 "stuck in
    // Awaiting resolution" bug: the query MUST include closed=true or resolved markets (which are
    // closed) come back empty and never settle. We assert both halves below.
    console.log("2. fetchResolution(open deck id) -> should be null (not resolved yet)...");
    const rOpen = await fetchResolution(c.polymarketId);
    assert.strictEqual(rOpen, null, "an OPEN market must NOT be returned by the resolution lookup");
    console.log("   ✓ open market correctly returns null");

    // Positive half: a genuinely resolved market MUST be found and map to RESOLVED. Pull one that
    // ended in the last 24h (closed=true) and round-trip it through fetchResolution. This is the
    // canary that would have caught the stuck-settlement bug.
    console.log("2b. fetchResolution(recently-resolved id) -> should be RESOLVED...");
    const closedRaw = await gammaGetForVerify(
      `/markets?closed=true&order=endDate&ascending=false&limit=20`,
    );
    const aResolved = closedRaw.find(
      (m) => m.conditionId && m.umaResolutionStatus === "resolved" && m.outcomePrices,
    );
    if (aResolved?.conditionId) {
      const rr = await fetchResolution(aResolved.conditionId);
      assert.ok(rr, "resolution lookup MUST return a closed/resolved market (closed=true param)");
      assert.strictEqual(rr!.polymarketId, aResolved.conditionId, "same id round-trips");
      console.log(`   status=${rr!.status} outcome=${rr!.resolvedOutcome ?? "—"} — ✓ resolved market found`);
    } else {
      console.warn("   ⚠ no clean resolved market in the last-20 closed sample right now; skipped positive check");
    }
  } else {
    console.warn(
      "   ⚠ deck empty right now — either thin <=24h pool this moment, or API shape drift. " +
        "Re-run later; check a wider window below.",
    );
    // Fallback: prove the parser on a 7-day window so we still validate field mapping.
    const wide = await fetchBlitzDeck(24 * 7, 20);
    console.log(`   7-day window has ${wide.length} markets (sanity on parser)`);
    assert.ok(wide.length > 0, "parser yields markets on a wider window");
  }

  // 3. mapMarket unit: a synthetic resolved-YES market maps correctly.
  const synthetic = mapMarket({
    conditionId: "0xtest",
    question: "Test?",
    endDate: new Date(Date.now() + 3_600_000).toISOString(),
    outcomes: '["Yes","No"]',
    outcomePrices: '["1","0"]',
    umaResolutionStatus: "resolved",
    closed: true,
  });
  assert.strictEqual(synthetic?.status, "RESOLVED");
  assert.strictEqual(synthetic?.resolvedOutcome, "YES");
  console.log("3. ✓ mapMarket resolves YES on [1,0] + umaResolutionStatus=resolved");

  // 3b. startsAt mapping: a market WITH startDate maps startsAt to that exact ISO; a market
  //     WITHOUT startDate maps startsAt to null (crypto/Yes-No have no meaningful start).
  const startIso = "2026-07-01T18:00:00Z";
  const withStart = mapMarket({
    conditionId: "0xstart",
    question: "Match starts later?",
    startDate: startIso,
    endDate: new Date(Date.now() + 3_600_000).toISOString(),
    outcomes: '["Team A","Team B"]',
    outcomePrices: '["0.5","0.5"]',
  });
  assert.strictEqual(withStart?.startsAt, startIso, "startDate present -> startsAt = that ISO");
  const noStart = mapMarket({
    conditionId: "0xnostart",
    question: "Crypto up or down?",
    endDate: new Date(Date.now() + 3_600_000).toISOString(),
    outcomes: '["Up","Down"]',
    outcomePrices: '["0.5","0.5"]',
  });
  assert.strictEqual(noStart?.startsAt, null, "no startDate -> startsAt = null");
  console.log("3b. ✓ mapMarket maps startsAt from startDate (ISO when present, null when absent)");

  // 4. Binary markets keep their REAL side labels (index 0 = YES side, index 1 = NO side).
  //    The card shows these, not a forced Yes/No. Covers Up/Down, teams, and Over/Under.
  const cases: { label: string; outcomes: string; prices: string; yesL: string; noL: string; yesBp: number; noBp: number }[] = [
    { label: "Up/Down", outcomes: '["Up", "Down"]', prices: '["0.7", "0.3"]', yesL: "Up", noL: "Down", yesBp: 7000, noBp: 3000 },
    { label: "teams", outcomes: '["L1ga Team", "4ikibamboni"]', prices: '["0.625", "0.375"]', yesL: "L1ga Team", noL: "4ikibamboni", yesBp: 6250, noBp: 3750 },
    { label: "Over/Under", outcomes: '["Over", "Under"]', prices: '["0.465", "0.535"]', yesL: "Over", noL: "Under", yesBp: 4650, noBp: 5350 },
  ];
  for (const c of cases) {
    const mk = mapMarket({
      conditionId: "0x" + c.label,
      question: `Binary: ${c.label}?`,
      endDate: new Date(Date.now() + 3_600_000).toISOString(),
      outcomes: c.outcomes,
      outcomePrices: c.prices,
    });
    assert.ok(mk, `${c.label} must map (binary with real labels)`);
    assert.strictEqual(mk!.outcomeYesLabel, c.yesL, `${c.label}: side-A label`);
    assert.strictEqual(mk!.outcomeNoLabel, c.noL, `${c.label}: side-B label`);
    assert.strictEqual(mk!.yesPriceBp, c.yesBp, `${c.label}: side-A price`);
    assert.strictEqual(mk!.noPriceBp, c.noBp, `${c.label}: side-B price`);
  }
  // Multi-outcome (>2) is still rejected — we don't model n-way bets.
  const multi = mapMarket({
    conditionId: "0xmulti", question: "Who wins?",
    endDate: new Date(Date.now() + 3_600_000).toISOString(),
    outcomes: '["A","B","C"]', outcomePrices: '["0.3","0.3","0.4"]',
  });
  assert.strictEqual(multi, null, "3-way market must be rejected");
  console.log("4. ✓ mapMarket keeps real labels for Up/Down, teams, Over/Under; rejects 3-way");

  console.log("\npolymarket: VERIFIED");
}

main().catch((e) => {
  console.error("polymarket verify FAILED:", e);
  process.exit(1);
});
