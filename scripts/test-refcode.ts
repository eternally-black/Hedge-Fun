// Self-checks for short referral codes (DB-free part). Run: npx tsx scripts/test-refcode.ts
import assert from "node:assert";
import { randomCode, isReserved, CODE_LEN } from "../src/lib/refcode";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ---- shape: every code is CODE_LEN chars, all from the alphabet, no look-alikes ----
for (let i = 0; i < 500; i++) {
  const c = randomCode();
  assert.strictEqual(c.length, CODE_LEN, `code length must be ${CODE_LEN}: ${c}`);
  for (const ch of c) assert.ok(ALPHABET.includes(ch), `char '${ch}' not in alphabet (${c})`);
  assert.ok(!/[IO01l]/.test(c), `look-alike char leaked into ${c}`);
}

// ---- reserved slugs rejected (case-insensitive — codes are upper, routes lower) ----
assert.ok(isReserved("api") && isReserved("API") && isReserved("Api"), "api must be reserved");
assert.ok(isReserved("r"), "single 'r' (our route) reserved");
assert.ok(!isReserved("XGVR"), "a normal code is not reserved");

// ---- spread: 500 draws should hit a decent chunk of the 31^4 space (no constant output) ----
const seen = new Set(Array.from({ length: 500 }, () => randomCode()));
assert.ok(seen.size > 480, `expected ~unique draws, got ${seen.size}/500 (generator stuck?)`);

console.log("refcode self-checks passed ✓");
