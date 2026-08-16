// Consent persistence and the Paper/Real switch behind it.
//
// This exists because of a real bug that shipped: the consent UPDATE was written as
// `NOT: { realConsentVersion: CURRENT }`, and in SQL `NOT (col = 'x')` is NULL — not true — when the
// column IS NULL, which is every user who has never consented. updateMany matched zero rows, consent
// silently never persisted, and the very next /api/real/mode answered 403 consent_required. On
// screen it looked like the button did nothing at all. A first-time acceptance is therefore the
// first thing asserted here.
//
// Run: npx tsx scripts/test-consent-mode.ts
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import { randomCode } from "../src/lib/refcode";
import { REAL_TERMS_VERSION } from "../src/lib/real-terms";

const STUB_DID = `did:privy:consent-${process.pid}-${Date.now() & 0xffffff}`;
(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: STUB_DID };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => ({
  email: { address: `${STUB_DID}@test.local` },
  twitter: null,
  wallet: null,
  linkedAccounts: [],
});

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const consent = await import("../src/app/api/real/consent/route");
  const mode = await import("../src/app/api/real/mode/route");

  const user = await prisma.user.create({
    data: {
      privyId: STUB_DID,
      email: `${STUB_DID}@test.local`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
    },
  });

  try {
    // ── Real mode is refused before consent ───────────────────────────────────────────────────
    const early = await mode.POST(post("http://x/api/real/mode", { real: true }));
    assert.strictEqual(early.status, 403, "no consent -> mode refuses");

    // ── THE REGRESSION: a first-time acceptance must actually persist ──────────────────────────
    const first = await consent.POST(post("http://x/api/real/consent", { accept: true, version: REAL_TERMS_VERSION }));
    assert.strictEqual(first.status, 200, "first consent accepted");
    const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.ok(afterFirst.realConsentAt !== null, "consent timestamp persisted on a NULL-version row");
    assert.strictEqual(afterFirst.realConsentVersion, REAL_TERMS_VERSION, "version recorded");

    // ── …and the switch now works ─────────────────────────────────────────────────────────────
    assert.strictEqual((await mode.POST(post("http://x/api/real/mode", { real: true }))).status, 200, "mode on");
    assert.strictEqual((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).realMode, true, "realMode set");

    // ── Re-consenting the SAME version does not move the original moment ───────────────────────
    const firstAt = afterFirst.realConsentAt;
    await consent.POST(post("http://x/api/real/consent", { accept: true, version: REAL_TERMS_VERSION }));
    const reconsented = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.strictEqual(+reconsented.realConsentAt!, +firstAt!, "same version is idempotent");

    // ── A version this client never rendered is refused, not silently recorded ─────────────────
    const wrong = await consent.POST(post("http://x/api/real/consent", { accept: true, version: "not-a-real-version" }));
    assert.strictEqual(wrong.status, 409, "stale/unknown version -> 409");
    assert.strictEqual(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).realConsentVersion,
      REAL_TERMS_VERSION,
      "a refused acceptance changes nothing",
    );

    // ── Turning it OFF is never gated — even with consent revoked underneath ───────────────────
    await prisma.user.update({ where: { id: user.id }, data: { realConsentAt: null, realConsentVersion: null } });
    assert.strictEqual((await mode.POST(post("http://x/api/real/mode", { real: false }))).status, 200, "off is ungated");
    assert.strictEqual(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).realMode,
      false,
      "a user can always get back to paper",
    );

    // ── Stale consent (older version) blocks the switch until re-accepted ──────────────────────
    await prisma.user.update({
      where: { id: user.id },
      data: { realConsentAt: new Date(), realConsentVersion: "2000-01-01.0" },
    });
    assert.strictEqual(
      (await mode.POST(post("http://x/api/real/mode", { real: true }))).status,
      409,
      "consent to an older text does not unlock the current one",
    );

    console.log("OK: consent persists on first acceptance, is versioned, and paper is always reachable");
    console.log("PASS: consent-mode");
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });
