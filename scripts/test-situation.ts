// DB-free self-check for the life-situation parser (B-P2) + the NLU schema extension.
// Same style as scripts/test-hedge-cores.ts — node:assert, no framework, no DB.
// Run: npx tsx scripts/test-situation.ts
import assert from "node:assert";
import { parseSituation } from "../src/lib/hedge/situation";
import { parseNluResponse } from "../src/lib/hedge/nlu";

// ─── money + period + distance extraction ────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(
    parseSituation("$800 on flights this month"),
    { amountCents: 80000, currency: "USD", period: "month", distanceKm: null },
    "$800 this month",
  );

  const eur = parseSituation("плачу 1200 евро за аренду");
  assert.strictEqual(eur.amountCents, 129600, "1200 EUR -> 129600 cents");
  assert.strictEqual(eur.currency, "EUR", "EUR currency");
  assert.strictEqual(eur.period, null, "'за аренду' is not a period");

  const km = parseSituation("~1000 km/month");
  assert.strictEqual(km.distanceKm, 1000, "1000 km");
  assert.strictEqual(km.period, "month", "km/month -> month");
  assert.strictEqual(km.amountCents, null, "no money in km/month");

  assert.strictEqual(parseSituation("1,5k$").amountCents, 150000, "1,5k$ -> 150000 cents");

  const uah = parseSituation("500 грн");
  assert.strictEqual(uah.amountCents, 1200, "500 UAH -> 1200 cents");
  assert.strictEqual(uah.currency, "UAH", "UAH currency");

  const bare = parseSituation("2000");
  assert.strictEqual(bare.amountCents, null, "bare number -> no amount");
  assert.strictEqual(bare.distanceKm, null, "bare number -> no distance");

  const miles = parseSituation("drive 600 miles a week");
  assert.strictEqual(miles.distanceKm, 965, "600 miles -> 965 km");
  assert.strictEqual(miles.period, "week", "a week -> week");
  assert.strictEqual(miles.amountCents, null, "a distance is not money");

  const rent = parseSituation("$1,200.50 rent per month");
  assert.strictEqual(rent.amountCents, 120050, "$1,200.50 -> 120050 cents");
  assert.strictEqual(rent.period, "month", "per month");

  assert.strictEqual(parseSituation("saving $3k a year").period, "year", "a year -> year");
  assert.strictEqual(parseSituation("saving $3k a year").amountCents, 300000, "$3k -> 300000 cents");

  const rub = parseSituation("I spend 30к рублей на такси в месяц");
  assert.strictEqual(rub.amountCents, 33000, "30к RUB -> 33000 cents");
  assert.strictEqual(rub.currency, "RUB", "RUB currency");
  assert.strictEqual(rub.period, "month", "в месяц -> month");

  const once = parseSituation("one time purchase of $50");
  assert.strictEqual(once.amountCents, 5000, "$50 -> 5000 cents");
  assert.strictEqual(once.period, "once", "one time -> once");

  assert.deepStrictEqual(
    parseSituation(""),
    { amountCents: null, currency: null, period: null, distanceKm: null },
    "empty -> all null",
  );
}

// ─── NLU schema extension: amountCents + period are OPTIONAL and OMITTED when invalid ─────────────
{
  // Old shape must round-trip byte-identically — no new keys when the model omits them.
  assert.deepStrictEqual(
    parseNluResponse('{"category":"sports","entities":["Los Angeles Lakers"],"keywords":["game"]}'),
    { category: "sports", entities: ["Los Angeles Lakers"], keywords: ["game"] },
    "no new keys when absent",
  );

  const withAmount = parseNluResponse(
    '{"category":"travel","entities":[],"keywords":["flights"],"amountCents":80000,"period":"month"}',
  );
  assert.ok(withAmount, "withAmount non-null");
  assert.strictEqual(withAmount!.amountCents, 80000, "amountCents carried through");
  assert.strictEqual(withAmount!.period, "month", "period carried through");

  const strAmount = parseNluResponse(
    '{"category":"travel","entities":[],"keywords":["flights"],"amountCents":"800"}',
  );
  assert.ok(strAmount, "strAmount non-null");
  assert.ok(!("amountCents" in strAmount!), "string amountCents -> key absent");

  const badPeriod = parseNluResponse(
    '{"category":"travel","entities":[],"keywords":["flights"],"period":"daily"}',
  );
  assert.ok(badPeriod, "badPeriod non-null");
  assert.ok(!("period" in badPeriod!), "invalid period -> key absent");

  const negAmount = parseNluResponse(
    '{"category":"travel","entities":[],"keywords":["flights"],"amountCents":-5}',
  );
  assert.ok(negAmount, "negAmount non-null");
  assert.ok(!("amountCents" in negAmount!), "negative amountCents -> key absent");

  const minimal = parseNluResponse('{"category":"driving","entities":[],"keywords":[]}');
  assert.ok(minimal, "category-only response is non-null");
}

console.log("test-situation: OK");
