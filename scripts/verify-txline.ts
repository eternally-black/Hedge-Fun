// Live canary for the TxLINE football integration (mirrors verify-polymarket). Read-only — needs a
// pre-activated apiToken in env (TXODDS_API_TOKEN / TXODDS_API_BASE). Run: npm run verify:txline
//
// Asserts the live data shapes the integration depends on: fixtures + World Cup filter, the O/U
// total-goals market extraction + bp ranges, the score shape, and the settlement open-paths. The
// resolved settlement branch (goals vs line) is covered offline by scripts/test-settle-football.ts.
import assert from "node:assert";
import { fetchFixtures, fetchOuMarkets, fetchMatchScore, WC_COMPETITION_ID } from "../src/lib/txodds";
import { resolveFootball } from "./settle-football";

async function main() {
  console.log("1. fetchFixtures() + World Cup filter");
  const fixtures = await fetchFixtures();
  assert.ok(Array.isArray(fixtures), "fixtures is an array");
  const wc = fixtures.filter((f) => f.CompetitionId === WC_COMPETITION_ID);
  console.log(`   fixtures=${fixtures.length}  WC(CompetitionId=${WC_COMPETITION_ID})=${wc.length}`);
  if (fixtures[0]) {
    for (const k of ["FixtureId", "StartTime", "Competition", "CompetitionId", "Participant1", "Participant2"] as const) {
      assert.ok(fixtures[0][k] !== undefined && fixtures[0][k] !== null, `fixture carries ${k}`);
    }
  }

  console.log("2. fetchOuMarkets() — O/U total-goals lines (1.5/2.5/3.5), demarginalized → bp");
  let ouCount = 0;
  let sample: (typeof wc)[number] | null = null;
  for (const f of wc.slice(0, 10)) {
    const lines = await fetchOuMarkets(f.FixtureId);
    for (const m of lines) {
      assert.ok(["1.5", "2.5", "3.5"].includes(m.line), `line ${m.line} is a .5 line`);
      assert.ok(m.overBp >= 0 && m.overBp <= 10000, "overBp in basis-point range");
      assert.ok(m.underBp >= 0 && m.underBp <= 10000, "underBp in basis-point range");
      ouCount++;
      if (!sample) sample = f;
    }
  }
  console.log(`   O/U lines across probed WC fixtures: ${ouCount}`);

  console.log("3. fetchMatchScore() — shape");
  if (sample) {
    const s = await fetchMatchScore(sample.FixtureId);
    assert.ok(typeof s.ended === "boolean", "ended is boolean");
    assert.ok(s.home === null || typeof s.home === "number", "home is number|null");
    console.log(`   ${sample.Participant1} vs ${sample.Participant2}: state="${s.gameState}" ${s.home}-${s.away} ended=${s.ended}`);
  }

  console.log("4. resolveFootball() — settlement open-paths");
  if (wc.length) {
    const farKickoff = wc.reduce((a, b) => (b.StartTime > a.StartTime ? b : a));
    const future = await resolveFootball(`txline:${farKickoff.FixtureId}:OU25`, Date.now() + 6 * 3_600_000);
    assert.strictEqual(future.resolution.kind, "open", "furthest-out match before deadline → open");
    console.log("   furthest-out match → open ✓");
  }
  const noop = await resolveFootball("0xnot-a-tx-market", 0);
  assert.strictEqual(noop.resolution.kind, "open", "non-tx market id → open (no-op)");
  console.log("   non-tx id → open ✓");

  console.log("\ntxline: VERIFIED");
}

main().catch((e) => {
  console.error("txline verify FAILED:", e);
  process.exit(1);
});
