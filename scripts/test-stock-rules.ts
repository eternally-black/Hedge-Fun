// DB-free self-check for the life-situation → tokenized-stock rule table (B-P1).
// Run: npx tsx scripts/test-stock-rules.ts
//
// The ticker snapshot was produced by this curl loop (9 pages, pageSize=100, until hasNextPage:false):
//   for p in 0 1 2 3 4 5 6 7 8; do
//     curl -s "https://api.xstocks.fi/api/v2/public/assets?network=Solana&pageSize=100&page=$p"
//   done
// collecting node.symbol for nodes with a Solana deployment into "symbols", and isTradingHalted
// symbols into "halted".
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  STOCK_RULES,
  WALLET_STOCK_RULES,
  tokenize,
  matchStockRules,
  ruleByCategory,
  evalTriggers,
  renderCopy,
  fmtChange,
  fmtPeriod,
  fmtDistance,
} from "../src/lib/hedge/stock-rules";

const snapshot = JSON.parse(
  readFileSync("scripts/stubs/xstocks-symbols.json", "utf8"),
) as { symbols: string[]; halted: string[] };
const SYMBOLS = new Set(snapshot.symbols);
const HALTED = new Set(snapshot.halted);

// ─── 1. Table integrity ─────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(STOCK_RULES.length, 13, "exactly 13 rules");
  const cats = new Set(STOCK_RULES.map((r) => r.category));
  assert.strictEqual(cats.size, 13, "categories unique");

  for (const r of STOCK_RULES) {
    assert.ok(r.tickers.length >= 1, `${r.category} has ≥1 ticker`);
    for (const t of r.tickers) {
      assert.ok(SYMBOLS.has(t), `${r.category} ticker ${t} in snapshot`);
      assert.ok(!HALTED.has(t), `${r.category} ticker ${t} not halted`);
    }
    assert.ok(r.copy.withAmount.includes("{ticker}"), `${r.category} withAmount has {ticker}`);
    assert.ok(r.copy.noAmount.includes("{ticker}"), `${r.category} noAmount has {ticker}`);
    if (r.trigger) {
      assert.ok(r.copy.spotted, `${r.category} has a trigger → needs copy.spotted`);
      assert.ok(SYMBOLS.has(r.trigger.symbol), `${r.category} trigger ${r.trigger.symbol} in snapshot`);
      assert.ok(!HALTED.has(r.trigger.symbol), `${r.category} trigger ${r.trigger.symbol} not halted`);
    }
  }

  for (const w of WALLET_STOCK_RULES) {
    for (const t of w.tickers) {
      assert.ok(SYMBOLS.has(t), `wallet ${w.asset} ticker ${t} in snapshot`);
      assert.ok(!HALTED.has(t), `wallet ${w.asset} ticker ${t} not halted`);
    }
  }

  // No normalized keyword appears in two different rules.
  const seen = new Map<string, string>();
  for (const r of STOCK_RULES) {
    for (const k of r.keywords) {
      const norm = tokenize(k).join(" ");
      if (!norm) continue;
      const prev = seen.get(norm);
      assert.ok(
        prev === undefined || prev === r.category,
        `keyword "${norm}" appears in ${prev} and ${r.category}`,
      );
      seen.set(norm, r.category);
    }
  }
}

// ─── 2. matchStockRules top category ────────────────────────────────────────────────────────────
{
  const top = (text: string, ctx?: { amountCents?: number | null; distanceKm?: number | null }) =>
    matchStockRules(text, ctx)[0]?.rule.category;

  assert.strictEqual(top("$800 on flights this month"), "travel");
  assert.strictEqual(top("лечу в отпуск, перелёт 30к"), "travel");
  assert.strictEqual(top("купую авіаквитки"), "travel");

  assert.strictEqual(top("I drive 1000 km a month"), "driving");
  assert.strictEqual(top("заправляюсь каждую неделю"), "driving");
  assert.strictEqual(top("пальне дорожчає"), "driving");

  assert.strictEqual(top("my rent is $1500"), "housing");
  assert.strictEqual(top("плачу 1200 евро за аренду"), "housing");
  assert.strictEqual(top("орендую квартиру"), "housing");

  assert.strictEqual(top("groceries at walmart cost more every week"), "groceries");
  assert.strictEqual(top("my electric bill doubled"), "energy");
  assert.strictEqual(top("health insurance premium went up"), "healthcare");
  assert.strictEqual(top("I work at a startup as a software engineer"), "tech_job");
  assert.strictEqual(top("holding a bitcoin bag"), "crypto");
  assert.strictEqual(top("netflix and spotify subscriptions"), "streaming");
  assert.strictEqual(top("ordering on amazon every week"), "shopping");
  assert.strictEqual(top("coffee at starbucks daily"), "dining");
  assert.strictEqual(top("inflation is eating my savings"), "market");
  assert.strictEqual(top("taxi to work every day"), "rides");
}

// ─── 3. Negatives → [] ──────────────────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(matchStockRules("I'm rooting for the Lakers"), []);
  assert.deepStrictEqual(matchStockRules("я болею за Реал"), []);
  assert.deepStrictEqual(matchStockRules("zzqqxwv"), []);
  assert.deepStrictEqual(matchStockRules(""), []);
}

// ─── 4. Edge cases ──────────────────────────────────────────────────────────────────────────────
{
  // "flying to the Lakers game" → exactly [travel]
  const flying = matchStockRules("flying to the Lakers game");
  assert.strictEqual(flying.length, 1);
  assert.strictEqual(flying[0]!.rule.category, "travel");

  // ё/й normalization: "полёт" and "полет" both → travel
  assert.strictEqual(matchStockRules("полёт")[0]?.rule.category, "travel");
  assert.strictEqual(matchStockRules("полет")[0]?.rule.category, "travel");

  // prefix: "арендую" → housing
  assert.strictEqual(matchStockRules("арендую")[0]?.rule.category, "housing");

  // "$800 on flights and $200 on uber" → [travel, rides]
  const two = matchStockRules("$800 on flights and $200 on uber");
  assert.deepStrictEqual(two.map((h) => h.rule.category), ["travel", "rides"]);

  // "$2000 a month" with amountCents → [market] with hits 0
  const market = matchStockRules("$2000 a month", { amountCents: 200_000 });
  assert.strictEqual(market.length, 1);
  assert.strictEqual(market[0]!.rule.category, "market");
  assert.strictEqual(market[0]!.hits, 0);

  // "I work at Amazon" → tech_job first (phrase "work at" = 2 hits beats amazon = 1)
  const amazon = matchStockRules("I work at Amazon");
  assert.strictEqual(amazon[0]!.rule.category, "tech_job");

  // "I drive to work" with distanceKm → driving first
  const drive = matchStockRules("I drive to work", { distanceKm: 1000 });
  assert.strictEqual(drive[0]!.rule.category, "driving");

  // Cap: a text hitting 4 categories returns at most 2
  const capped = matchStockRules("flights rent groceries coffee");
  assert.ok(capped.length <= 2, "cap at HEDGE_STOCK_MAX_CATEGORIES");
}

// ─── 5. evalTriggers ────────────────────────────────────────────────────────────────────────────
{
  const cats = (m: Record<string, number>) => evalTriggers(m).map((x) => x.rule.category);

  assert.deepStrictEqual(cats({ XLEx: 620 }), ["driving"]);
  assert.strictEqual(evalTriggers({ XLEx: 620 })[0]!.changeBp, 620);
  assert.deepStrictEqual(cats({ XLEx: 300 }), []);
  assert.deepStrictEqual(cats({ XLEx: -620 }), []);
  assert.deepStrictEqual(cats({ QQQx: -350 }), ["tech_job"]);
  assert.deepStrictEqual(cats({ BITXx: -700 }), ["crypto"]);
  assert.deepStrictEqual(cats({ SPYx: -250, XLEx: 900 }), ["driving", "market"]);
}

// ─── 6. renderCopy ──────────────────────────────────────────────────────────────────────────────
{
  const travel = ruleByCategory("travel")!;
  assert.strictEqual(
    renderCopy(travel.copy.withAmount, { amount: "$800", period: "this month", ticker: "DALx" }),
    "You're spending $800 on flights this month. Hedge your travel costs with DALx.",
  );

  const driving = ruleByCategory("driving")!;
  assert.strictEqual(
    renderCopy(driving.copy.spotted!, { change: "+8.0%", distance: "~1,000 km/month", ticker: "XOMx" }),
    "Energy stocks just jumped +8.0%. You drive ~1,000 km/month. Consider XOMx as a fuel-cost hedge.",
  );

  const btc = WALLET_STOCK_RULES.find((w) => w.asset === "BTC")!;
  assert.strictEqual(
    renderCopy(btc.copy, { amount: "$1,234", ticker: "GLDx" }),
    "Your wallet holds $1,234 of BTC — hedge 10% with GLDx. Gold is the old hard money; it zigs when crypto zags, sometimes.",
  );

  assert.strictEqual(
    renderCopy(driving.copy.noAmount, { ticker: "XOMx" }),
    "You drive a fair bit. XOMx moves with crude — consider it a fuel-cost hedge.",
  );

  // No double spaces anywhere in any rendered template with empty period.
  for (const r of STOCK_RULES) {
    for (const tpl of [r.copy.withAmount, r.copy.noAmount, r.copy.spotted]) {
      if (!tpl) continue;
      const out = renderCopy(tpl, { ticker: "XOMx" });
      assert.ok(!/ {2,}/.test(out), `no double spaces in ${r.category}: ${out}`);
    }
  }
}

// ─── 7. formatters ──────────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fmtChange(800), "+8.0%");
  assert.strictEqual(fmtChange(-350), "−3.5%");
  assert.strictEqual(fmtPeriod("month"), "this month");
  assert.strictEqual(fmtPeriod(null), "");
  assert.strictEqual(fmtDistance(1000, "month"), "~1,000 km/month");
}

console.log("test-stock-rules: OK");
