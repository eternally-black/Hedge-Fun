// DB-free self-check for the device fingerprint logic. Same style as test-quote.ts — node:assert,
// no framework, no DB, no network. Run: npx tsx scripts/test-refclick.ts
import assert from "node:assert";
import { sameDevice } from "../src/lib/refclick";

// Two fingerprints sharing an ipHash but with different uaHash are the SAME device — the UA half is
// attacker-chosen and cannot carry a same-human decision.
const ip = new Uint8Array([1, 2, 3, 4]);
const ua1 = new Uint8Array([5, 6, 7, 8]);
const ua2 = new Uint8Array([9, 10, 11, 12]);

assert.strictEqual(
  sameDevice({ ipHash: ip, uaHash: ua1 }, { ipHash: ip, uaHash: ua2 }),
  true,
  "same IP, different UA -> same device",
);

// Different ipHash -> different device, regardless of UA.
assert.strictEqual(
  sameDevice({ ipHash: ip, uaHash: ua1 }, { ipHash: new Uint8Array([2, 3, 4, 5]), uaHash: ua1 }),
  false,
  "different IP -> different device",
);

console.log("✓ refclick: same IP is the same device, the UA half is not trusted");
