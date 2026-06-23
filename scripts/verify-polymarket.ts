// Live verification of the Polymarket Gamma integration. Run: npm run verify:polymarket
// Hits the real API and asserts the blueprint's VERIFY-AT-RUNTIME flags hold.
import assert from "node:assert";
import { fetchBlitzDeck, fetchResolution, mapMarket } from "../src/lib/polymarket";

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

    console.log("2. fetchResolution(sample id)...");
    const r = await fetchResolution(c.polymarketId);
    assert.ok(r, "resolution lookup returns the market");
    assert.strictEqual(r!.polymarketId, c.polymarketId, "same id round-trips");
    console.log(`   status=${r!.status} outcome=${r!.resolvedOutcome ?? "—"}`);
    console.log("   ✓ resolution lookup works");
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

  console.log("\npolymarket: VERIFIED");
}

main().catch((e) => {
  console.error("polymarket verify FAILED:", e);
  process.exit(1);
});
