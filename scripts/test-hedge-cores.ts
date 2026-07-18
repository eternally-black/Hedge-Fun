// DB-free self-check for the hedge engine PURE cores (spec §4): parse, exposure, size, match, id.
// Same style as scripts/test-deck-mix.ts — node:assert, no framework, no DB. Run: npx tsx scripts/test-hedge-cores.ts
import assert from "node:assert";
import { parseStrikeMarket } from "../src/lib/hedge/parse";
import { exposureFromBalances, WSOL_MINT, type ExposureResult } from "../src/lib/hedge/exposure";
import { sizeS1 } from "../src/lib/hedge/size";
import { matchS1, type IndexedMarket } from "../src/lib/hedge/match";
import { suggestionId, s2SuggestionId } from "../src/lib/hedge/id";
import {
  normalize,
  scoreMatch,
  opposingSide,
  isNamedEntityShape,
  type S2Candidate,
} from "../src/lib/hedge/s2match";
import { parseNluResponse } from "../src/lib/hedge/nlu";
import { sideWithinAcceptBand } from "../src/lib/hedge/accept";
import { HEDGE_ACCEPT_SIDE_FLOOR_BP, HEDGE_ACCEPT_SIDE_CEIL_BP } from "../src/lib/config";
import {
  HEDGE_MAJOR_PCT_BP,
  HEDGE_PROXY_PCT_BP,
  HEDGE_MAX_STAKE_CENTS,
  HEDGE_MIN_NOTIONAL_CENTS,
  HEDGE_MIN_LEAD_MS,
  S2_CONFIDENCE_THRESHOLD,
} from "../src/lib/config";

// ─── parse: strike + date + direction from real Gamma slugs (verified live 2026-07-17) ──────────────
{
  const p = (slug: string, question?: string) => parseStrikeMarket({ slug, question });

  const above = p("bitcoin-above-62600-on-july-17-2026-2pm-et");
  assert.deepStrictEqual(
    { a: above.asset, s: above.strikeCents, d: above.direction, ok: above.parseOk },
    { a: "BTC", s: 6_260_000, d: "UP", ok: true },
    "above -> BTC UP strike $62,600",
  );

  const eth = p("ethereum-above-1810-on-july-17-2026-2pm-et");
  assert.deepStrictEqual({ a: eth.asset, s: eth.strikeCents, d: eth.direction, ok: eth.parseOk }, { a: "ETH", s: 181_000, d: "UP", ok: true }, "ETH above 1810");

  const dip = p("will-bitcoin-dip-to-57k-on-july-17");
  assert.deepStrictEqual({ a: dip.asset, s: dip.strikeCents, d: dip.direction, ok: dip.parseOk }, { a: "BTC", s: 5_700_000, d: "DOWN", ok: true }, "dip-to 57k -> DOWN $57,000");

  const reach = p("will-solana-reach-100-on-july-17");
  assert.deepStrictEqual({ a: reach.asset, s: reach.strikeCents, d: reach.direction, ok: reach.parseOk }, { a: "SOL", s: 10_000, d: "UP", ok: true }, "reach 100 -> SOL UP $100");

  const hit = p("will-bitcoin-hit-150k-by-december-31-2026");
  assert.deepStrictEqual({ a: hit.asset, s: hit.strikeCents, d: hit.direction, ok: hit.parseOk }, { a: "BTC", s: 15_000_000, d: "UP", ok: true }, "hit 150k -> UP $150,000");

  const below = p("solana-below-90-on-july-20-2026");
  assert.deepStrictEqual({ a: below.asset, s: below.strikeCents, d: below.direction, ok: below.parseOk }, { a: "SOL", s: 9_000, d: "DOWN", ok: true }, "below 90 -> SOL DOWN");

  // Question fallback (commas stripped, spaces normalized) when the slug is opaque/absent.
  const fromQ = parseStrikeMarket({ question: "Bitcoin above 62,600 on July 17, 2PM ET?" });
  assert.deepStrictEqual({ a: fromQ.asset, s: fromQ.strikeCents, d: fromQ.direction, ok: fromQ.parseOk }, { a: "BTC", s: 6_260_000, d: "UP", ok: true }, "question fallback parses strike");

  // NOT S1-eligible (asset recognized, but no machine-readable strike+direction) -> parseOk false.
  const updown = p("btc-updown-5m-1784310300", "Bitcoin Up or Down - July 17, 1:45PM-1:50PM ET");
  assert.strictEqual(updown.asset, "BTC", "updown still tags asset");
  assert.strictEqual(updown.parseOk, false, "Up/Down daily has no strike -> skipped");
  assert.strictEqual(updown.strikeCents, null, "no strike on Up/Down");

  for (const slug of [
    "bitcoin-etf-flows-on-july-17",
    "will-the-price-of-solana-be-between-80-90-on-july-20-2026",
    "solana-all-time-high-by-september-30-2026",
  ]) {
    assert.strictEqual(p(slug).parseOk, false, `${slug} -> not S1-eligible`);
  }

  // Strike present but NO date -> the date gate keeps it out of S1.
  const noDate = p("bitcoin-above-62600");
  assert.strictEqual(noDate.strikeCents, 6_260_000, "strike parsed without a date");
  assert.strictEqual(noDate.hasDate, false, "no date token");
  assert.strictEqual(noDate.parseOk, false, "strike but no date -> not eligible");
}

// ─── exposure: majors (native SOL + wSOL merge, wrapped BTC/ETH) vs long-tail SPL aggregate ─────────
{
  const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
  const FOO = "Foo1111111111111111111111111111111111111111";
  const balances = [
    { mint: null, symbol: "SOL", uiAmount: 10 }, // native SOL
    { mint: WSOL_MINT, symbol: "wSOL", uiAmount: 5 }, // wrapped SOL -> merges into SOL major
    { mint: WBTC, symbol: "WBTC", uiAmount: 0.01 },
    { mint: FOO, symbol: "FOO", uiAmount: 1000 }, // long-tail SPL
    { mint: "Unpriced1111111111111111111111111111111111", symbol: "NIL", uiAmount: 999 }, // no price -> ignored
  ];
  const prices = { [WSOL_MINT]: 75, [WBTC]: 60000, [FOO]: 0.5 };
  const e = exposureFromBalances(balances, prices);

  assert.strictEqual(e.majors.length, 2, "SOL + BTC majors");
  const sol = e.majors.find((m) => m.asset === "SOL")!;
  assert.strictEqual(sol.notionalCents, 112_500, "SOL major = (10+5) × $75 = $1125");
  assert.strictEqual(sol.mint, null, "merged SOL major represents native");
  const btc = e.majors.find((m) => m.asset === "BTC")!;
  assert.strictEqual(btc.notionalCents, 60_000, "BTC major = 0.01 × $60,000 = $600");
  assert.strictEqual(e.majors[0].asset, "SOL", "majors sorted by notional desc");
  assert.strictEqual(e.splAggregateCents, 50_000, "SPL aggregate = 1000 × $0.50 = $500");
  assert.strictEqual(e.totalNotionalCents, 222_500, "total = 112500 + 60000 + 50000");
}

// ─── size: product-rule percentages + clamps ────────────────────────────────────────────────────
{
  assert.strictEqual(sizeS1(100_000, "S1_MAJOR"), Math.round((100_000 * HEDGE_MAJOR_PCT_BP) / 10_000), "major % of $1000");
  assert.strictEqual(sizeS1(100_000, "S1_PROXY"), Math.round((100_000 * HEDGE_PROXY_PCT_BP) / 10_000), "proxy % of $1000");
  assert.strictEqual(sizeS1(1_000, "S1_MAJOR"), 0, "below min clamp -> 0 (skip)");
  assert.strictEqual(sizeS1(1_000_000_00, "S1_MAJOR"), HEDGE_MAX_STAKE_CENTS, "above max clamp -> capped");
  assert.strictEqual(sizeS1(0, "S1_MAJOR"), 0, "zero notional -> 0");
}

// ─── match: opposite-direction side selection, ranking, lead filter, proxy ──────────────────────────
{
  const now = 1_800_000_000_000;
  const h = (n: number) => now + n * 3_600_000;
  const exposure: ExposureResult = {
    assets: [],
    majors: [{ asset: "SOL", mint: null, amount: 15, priceCents: 7500, notionalCents: 112_500, isMajor: true }],
    splAggregateCents: 50_000,
    totalNotionalCents: 162_500,
  };
  const markets: IndexedMarket[] = [
    { marketId: "m-up", asset: "SOL", direction: "UP", strikeCents: 10_000_000, deadlineMs: h(2), liquidityCents: 500_000, yesPriceBp: 4000, noPriceBp: 6000 },
    { marketId: "m-down", asset: "SOL", direction: "DOWN", strikeCents: 5_000_000, deadlineMs: h(3), liquidityCents: 100_000, yesPriceBp: 3000, noPriceBp: 7000 },
    { marketId: "m-soon", asset: "SOL", direction: "UP", strikeCents: 9_000_000, deadlineMs: now + HEDGE_MIN_LEAD_MS - 1, liquidityCents: 999_999, yesPriceBp: 4000, noPriceBp: 6000 },
    { marketId: "m-btc", asset: "BTC", direction: "UP", strikeCents: 6_000_000_0, deadlineMs: h(4), liquidityCents: 900_000, yesPriceBp: 4000, noPriceBp: 6000 },
  ];

  const cands = matchS1(exposure, markets, now, { perAsset: 1 });
  assert.strictEqual(cands.length, 2, "one major + one proxy");

  const major = cands.find((c) => c.kind === "S1_MAJOR")!;
  assert.strictEqual(major.marketId, "m-up", "major hedge picks the highest-liquidity SOL market (not the too-soon one)");
  assert.strictEqual(major.side, "NO", "hedging a long vs an UP market -> NO side");
  assert.strictEqual(major.sidePriceBp, 6000, "locks the NO price");
  assert.strictEqual(major.hedgedAsset, "SOL");
  assert.strictEqual(major.isProxy, false);

  const proxy = cands.find((c) => c.kind === "S1_PROXY")!;
  assert.strictEqual(proxy.marketId, "m-down", "proxy uses the next SOL market, not the one already used");
  assert.strictEqual(proxy.side, "YES", "DOWN market -> YES side benefits from a fall");
  assert.strictEqual(proxy.hedgedNotionalCents, 50_000, "proxy hedges the SPL aggregate");
  assert.strictEqual(proxy.isProxy, true);

  // No BTC holding -> no BTC candidate even though a BTC market exists.
  assert.ok(!cands.some((c) => c.marketId === "m-btc"), "no holding -> no BTC hedge");

  // A dust-only wallet yields nothing.
  const dust: ExposureResult = { assets: [], majors: [{ asset: "SOL", mint: null, amount: 0.001, priceCents: 7500, notionalCents: HEDGE_MIN_NOTIONAL_CENTS - 1, isMajor: true }], splAggregateCents: 0, totalNotionalCents: HEDGE_MIN_NOTIONAL_CENTS - 1 };
  assert.strictEqual(matchS1(dust, markets, now).length, 0, "dust holding -> no suggestion");
}

// ─── id: deterministic, stable, content-sensitive ────────────────────────────────────────────────
{
  const base = { address: "So1AddrXYZ", marketId: "m-up", kind: "S1_MAJOR", side: "NO", hedgedNotionalCents: 112_500, proposedStakeCents: 7875 };
  const a = suggestionId(base);
  const b = suggestionId({ ...base });
  assert.strictEqual(a, b, "same inputs -> same id (re-derivable -> idempotent accept)");
  assert.strictEqual(a.length, 32, "32-hex id");
  assert.notStrictEqual(a, suggestionId({ ...base, proposedStakeCents: 8000 }), "different sizing -> different id");
  assert.notStrictEqual(a, suggestionId({ ...base, side: "YES" }), "different side -> different id");
}

// ─── S2 normalize: lowercase, diacritics, punctuation, stopwords, Cyrillic survives ─────────────────
{
  assert.deepStrictEqual(normalize("Real Madrid"), ["real", "madrid"], "basic tokenization");
  assert.deepStrictEqual(normalize("FC Barcelona!"), ["barcelona"], "drops 'fc' stopword + punctuation");
  assert.deepStrictEqual(normalize("Atlético"), ["atletico"], "strips diacritics");
  assert.deepStrictEqual(normalize("я болею за Реал"), ["реал"], "RU stopwords dropped, Cyrillic entity survives");
  assert.deepStrictEqual(normalize("   "), [], "whitespace only -> no tokens");
}

// ─── S2 scoreMatch: exact / alias / substring / trigram + threshold + ranking ───────────────────────
{
  const cands: S2Candidate[] = [
    { ref: "e|m1|YES", label: "Barcelona", kind: "entity" },
    { ref: "e|m1|NO", label: "Real Madrid", kind: "entity" },
    { ref: "e|m2|YES", label: "Manchester United", kind: "entity" },
    { ref: "l|soccer", label: "Soccer", kind: "league" },
    { ref: "q|m1", label: "Barcelona vs Real Madrid: who wins?", kind: "question" },
  ];

  // Exact entity match tops the ranking at ~1.0.
  const exact = scoreMatch("Barcelona", cands);
  assert.strictEqual(exact[0].ref, "e|m1|YES", "exact entity ranks first");
  assert.strictEqual(exact[0].score, 1, "exact match scores 1.0");
  assert.ok(exact[0].score >= S2_CONFIDENCE_THRESHOLD, "exact passes threshold");

  // Alias/translit: "барса" (RU nickname) -> Barcelona via the curated alias table, above threshold.
  const alias = scoreMatch("барса", cands);
  assert.strictEqual(alias[0].ref, "e|m1|YES", "alias resolves барса -> Barcelona");
  assert.strictEqual(alias[0].method, "alias", "flagged as an alias match");
  assert.ok(alias[0].score >= S2_CONFIDENCE_THRESHOLD, "alias passes threshold");

  // Multi-token partial: "man united" -> "Manchester United" via token coverage, above threshold.
  const partial = scoreMatch("man united", cands);
  assert.strictEqual(partial[0].ref, "e|m2|YES", "man united -> Manchester United");
  assert.ok(partial[0].score >= S2_CONFIDENCE_THRESHOLD, "strong partial passes threshold");

  // Garbage query matches nothing above threshold (would trigger NLU edge / fallback in the DB layer).
  const junk = scoreMatch("zzqqxwv", cands);
  assert.ok(junk.length === 0 || junk[0].score < S2_CONFIDENCE_THRESHOLD, "garbage falls below threshold");

  // Empty query -> no matches.
  assert.deepStrictEqual(scoreMatch("   ", cands), [], "empty query -> []");

  // Deterministic: same inputs -> identical ranking (re-derivable).
  assert.deepStrictEqual(scoreMatch("Barcelona", cands), exact, "scoreMatch is deterministic");
}

// ─── S2 against-side selection + shape guard (pure) ─────────────────────────────────────────────────
{
  assert.strictEqual(opposingSide("YES"), "NO", "support YES side -> hedge NO");
  assert.strictEqual(opposingSide("NO"), "YES", "support NO side -> hedge YES");

  assert.ok(isNamedEntityShape("Barcelona", "Real Madrid"), "team vs team is a named shape");
  assert.ok(!isNamedEntityShape("Over", "Under"), "Over/Under is NOT a hedgeable named shape");
  assert.ok(!isNamedEntityShape("Up", "Down"), "Up/Down is not named");
  assert.ok(!isNamedEntityShape("Yes", "No"), "Yes/No is not named");
  assert.ok(!isNamedEntityShape("", "Real Madrid"), "empty label -> not named");
}

// ─── S2 id: deterministic, namespace-disjoint from S1, side/kind-sensitive ──────────────────────────
{
  const s = s2SuggestionId({ marketId: "m1", kind: "S2", side: "NO", proposedStakeCents: 1000 });
  assert.strictEqual(s, s2SuggestionId({ marketId: "m1", kind: "S2", side: "NO", proposedStakeCents: 1000 }), "stable");
  assert.strictEqual(s.length, 32, "32-hex id");
  assert.notStrictEqual(s, s2SuggestionId({ marketId: "m1", kind: "S2", side: "YES", proposedStakeCents: 1000 }), "side-sensitive");
  assert.notStrictEqual(s, s2SuggestionId({ marketId: "m1", kind: "FALLBACK", side: "NO", proposedStakeCents: 1000 }), "kind-sensitive");
}

// ─── NLU parse: strict JSON extraction from a MOCKED model response (no network in tests) ───────────
{
  // Well-formed, wrapped in prose + code fences (tolerant extraction).
  const ok = parseNluResponse('Here you go:\n```json\n{"category":"sports","entities":["Real Madrid"],"keywords":["match"]}\n```');
  assert.deepStrictEqual(ok, { category: "sports", entities: ["Real Madrid"], keywords: ["match"] }, "parses fenced JSON");

  // Coerces/cleans: non-string array members dropped, category lowercased, blanks removed.
  const coerced = parseNluResponse('{"category":"Entertainment","entities":["Dune",2,""],"keywords":[" film "]}');
  assert.deepStrictEqual(coerced, { category: "entertainment", entities: ["Dune"], keywords: ["film"] }, "coerces + trims");

  assert.strictEqual(parseNluResponse("not json at all"), null, "no JSON -> null");
  assert.strictEqual(parseNluResponse('{"category":null,"entities":[],"keywords":[]}'), null, "empty signal -> null");
  assert.strictEqual(parseNluResponse("{ broken"), null, "malformed JSON -> null");
}

// ── accept-time price band (F1 TOCTOU gate) ────────────────────────────────────────────────────────
// The derive path band-filters with the same bounds, so integration can't stage an out-of-band
// accept; the pure gate is asserted directly at its boundaries instead.
{
  assert.strictEqual(sideWithinAcceptBand(HEDGE_ACCEPT_SIDE_FLOOR_BP), true, "floor is inside the band");
  assert.strictEqual(sideWithinAcceptBand(HEDGE_ACCEPT_SIDE_CEIL_BP), true, "ceil is inside the band");
  assert.strictEqual(sideWithinAcceptBand(HEDGE_ACCEPT_SIDE_FLOOR_BP - 1), false, "below floor -> degenerate");
  assert.strictEqual(sideWithinAcceptBand(HEDGE_ACCEPT_SIDE_CEIL_BP + 1), false, "above ceil -> degenerate");
  assert.strictEqual(sideWithinAcceptBand(50), false, "collapsed 0.5% side (decided market) rejected");
  assert.strictEqual(sideWithinAcceptBand(9950), false, "collapsed 99.5% side (decided market) rejected");
  assert.strictEqual(sideWithinAcceptBand(5000), true, "mid-book price accepted");
}

console.log("hedge cores: OK");
