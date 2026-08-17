// /api/real/creds — storing the browser's L2 CLOB credentials, and handing them back to it.
//
// The GET exists because deriving fresh credentials on every page load does not work: the CLOB
// answers POST /auth/api-key with 400 once a key exists for the address, and the failure lands
// inside the SDK before any of our routes run — the first real swipe died there with nothing in the
// logs. The first version of the GET then broke in its own right by copying the same-origin check
// off the POST: browsers omit Origin on same-origin GETs, so it 403'd every legitimate call and sent
// the client straight back to deriving. A request WITHOUT an Origin header is therefore the first
// thing asserted here.
//
// Run: npx tsx scripts/test-clob-creds-route.ts
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import { randomCode } from "../src/lib/refcode";
import { REAL_TERMS_VERSION } from "../src/lib/real-terms";

const STUB_DID = `did:privy:creds-${process.pid}-${Date.now() & 0xffffff}`;
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

// AES-256-GCM key: the store is a no-op without it, and this route is the only reader/writer.
process.env.REAL_CREDS_KEY = "a".repeat(64);
// Set so the POST's same-origin check is live — the point being that the GET still works without an
// Origin header while the POST is genuinely enforcing one.
process.env.APP_ORIGIN = "https://app.test";

const CREDS = { key: "k-1234", secret: "c2VjcmV0LXZhbHVl", passphrase: "pass-phrase-1234" };

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const creds = await import("../src/app/api/real/creds/route");

  const user = await prisma.user.create({
    data: {
      privyId: STUB_DID,
      email: `${STUB_DID}@test.local`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      realConsentAt: new Date(),
      realConsentVersion: REAL_TERMS_VERSION,
      depositWalletAddress: `0x${(Date.now() % 1e12).toString(16).padStart(40, "0")}`,
    },
  });

  // No Origin header — exactly what a browser sends for a same-origin GET.
  const get = () => creds.GET(new Request("http://x/api/real/creds", { headers: { authorization: "Bearer good" } }));
  const post = (body: unknown, origin: string | null = "https://app.test") =>
    creds.POST(
      new Request("http://x/api/real/creds", {
        method: "POST",
        headers: {
          authorization: "Bearer good",
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  try {
    // ── Nothing stored yet: 404, which the client answers by deriving — not an error ─────────────
    assert.strictEqual((await get()).status, 404, "no creds yet -> 404, not 500");

    // ── Store them ───────────────────────────────────────────────────────────────────────────────
    assert.strictEqual((await post(CREDS)).status, 200, "creds saved");

    // ── THE REGRESSION: a GET with NO Origin header must succeed and return what was stored ──────
    const res = await get();
    assert.strictEqual(res.status, 200, "same-origin GET carries no Origin header and must not 403");
    assert.deepStrictEqual(await res.json(), CREDS, "round-trips through encryption unchanged");
    assert.strictEqual(res.headers.get("cache-control"), "no-store", "credentials are never cached");

    // ── The POST keeps its same-origin gate: it is the state-changing half ───────────────────────
    assert.strictEqual((await post(CREDS, "https://evil.test")).status, 403, "foreign origin refused on POST");
    assert.strictEqual((await post(CREDS, null)).status, 403, "a POST without Origin is refused too");

    // ── Auth is the real gate on the GET ─────────────────────────────────────────────────────────
    const anon = await creds.GET(new Request("http://x/api/real/creds"));
    assert.strictEqual(anon.status, 401, "no token -> 401");

    // ── Revoked creds read as absent, so the client derives instead of using a dead key ──────────
    await prisma.clobCredential.update({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    assert.strictEqual((await get()).status, 404, "revoked -> 404");

    console.log("OK: creds round-trip; the GET works without an Origin header, the POST still needs one");
    console.log("PASS: clob-creds-route");
  } finally {
    await prisma.clobCredential.deleteMany({ where: { userId: user.id } });
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
