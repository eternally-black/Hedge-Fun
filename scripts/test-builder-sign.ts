// /api/builder/sign binds every relayer envelope to the caller — including the FIRST one.
//
// This exists because of a bug that made real-money setup impossible for every pre-existing account:
// users.embeddedWalletAddress is NULL for anyone created before the column existed, and the only
// thing that backfilled it was /api/real/wallet — which provisionReal calls AFTER deployDepositWallet
// has already come through this route. So the relayer envelope was compared against NULL, refused as
// not_your_wallet, and the profile just said "Set up failed". The backfill-on-NULL path is therefore
// the first thing asserted here, together with the refusals it must NOT weaken.
//
// Run: npx tsx scripts/test-builder-sign.ts
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import { randomCode } from "../src/lib/refcode";
import { REAL_TERMS_VERSION } from "../src/lib/real-terms";

const STUB_DID = `did:privy:buildersign-${process.pid}-${Date.now() & 0xffffff}`;
const EMBEDDED = "0x00000000000000000000000000000000000000ab";
const OTHER_EOA = "0x00000000000000000000000000000000000000cd";
const DEPOSIT = "0x00000000000000000000000000000000000000ef";

// Privy is the source of truth for the embedded wallet; `privyWallet` is what it currently answers.
let privyWallet: string | null = EMBEDDED;
let getUserCalls = 0;

(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: STUB_DID };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => {
  getUserCalls++;
  return {
    email: { address: `${STUB_DID}@test.local` },
    twitter: null,
    wallet: privyWallet ? { address: privyWallet, chainType: "ethereum", walletClientType: "privy" } : null,
    linkedAccounts: [],
  };
};

// The HMAC secret is base64 in the real config; any decodable value works for the signing step.
process.env.POLYMARKET_BUILDER_API_KEY = "test-key";
process.env.POLYMARKET_BUILDER_SECRET = Buffer.from("test-secret").toString("base64");
process.env.POLYMARKET_BUILDER_PASSPHRASE = "test-passphrase";
delete process.env.APP_ORIGIN; // unset = same-origin check disabled, so it is not what is under test

const submit = (body: unknown) =>
  new Request("http://x/api/builder/sign", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ method: "POST", path: "/submit", body: JSON.stringify(body) }),
  });

// What this test can and cannot see: the HMAC step lazy-imports the SDK, whose root barrel does not
// load under tsx's CJS resolution, so an ALLOWED request ends at sign_failed (500) here while
// production returns 200. That is fine — the subject is the access decision, and 403 is exactly the
// verdict the bug produced. "Not refused" is therefore the real assertion; 200-vs-500 is harness
// noise and pinning it would only pin the harness.
const REFUSED = 403;
const refusedAs = async (res: Response): Promise<string | null> =>
  res.status === REFUSED ? ((await res.json()) as { error: string }).error : null;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const sign = await import("../src/app/api/builder/sign/route");

  const user = await prisma.user.create({
    data: {
      privyId: STUB_DID,
      email: `${STUB_DID}@test.local`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      // Consent is a precondition of the route, not the subject of this test.
      realConsentAt: new Date(),
      realConsentVersion: REAL_TERMS_VERSION,
      // THE PRECONDITION THAT BROKE IT: a legacy row with no wallet recorded.
      embeddedWalletAddress: null,
    },
  });

  try {
    // ── THE REGRESSION: the first envelope, from a row with a NULL wallet, must get through ──────
    assert.strictEqual(
      await refusedAs(await sign.POST(submit({ from: EMBEDDED }))),
      null,
      "first deploy envelope is accepted, not refused as not_your_wallet",
    );

    // ── The sync PERSISTED, so it does not repeat on every CLOB read (240/min through here) ──────
    const synced = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.strictEqual(synced.embeddedWalletAddress, EMBEDDED, "backfilled onto the row");
    const callsAfterFirst = getUserCalls;
    assert.strictEqual(await refusedAs(await sign.POST(submit({ from: EMBEDDED }))), null, "second call still passes");
    assert.strictEqual(getUserCalls, callsAfterFirst, "…without a second Privy round-trip");

    // ── The backfill must not have weakened the binding: another EOA is still refused ────────────
    assert.strictEqual(
      await refusedAs(await sign.POST(submit({ from: OTHER_EOA }))),
      "not_your_wallet",
      "an envelope from someone else's EOA is refused",
    );

    // ── A deposit wallet this user does not own is refused even when `from` is theirs ────────────
    await prisma.user.update({ where: { id: user.id }, data: { depositWalletAddress: DEPOSIT } });
    assert.strictEqual(
      await refusedAs(await sign.POST(submit({ from: EMBEDDED, depositWalletParams: { depositWallet: OTHER_EOA } }))),
      "not_your_wallet",
      "someone else's deposit wallet is refused",
    );
    assert.strictEqual(
      await refusedAs(await sign.POST(submit({ from: EMBEDDED, depositWalletParams: { depositWallet: DEPOSIT } }))),
      null,
      "…their own is accepted",
    );

    // ── Privy has no embedded wallet yet: fail CLOSED, never sign for an unknown signer ──────────
    await prisma.user.update({ where: { id: user.id }, data: { embeddedWalletAddress: null } });
    privyWallet = null;
    assert.strictEqual(
      await refusedAs(await sign.POST(submit({ from: EMBEDDED }))),
      "not_your_wallet",
      "no embedded wallet at Privy -> refuse, not sign",
    );

    // ── The SDK's auth reads must pass; only the BUILDER's own key stays off limits ─────────────
    // /auth/api-keys validates the credentials we hand the client. It was denied once, and that
    // refusal failed every real order — the browser only saw "status 403".
    const get = (p: string) =>
      sign.POST(
        new Request("http://x/api/builder/sign", {
          method: "POST",
          headers: { authorization: "Bearer good", "content-type": "application/json" },
          body: JSON.stringify({ method: "GET", path: p }),
        }),
      );
    assert.notStrictEqual((await get("/auth/api-keys")).status, 403, "the SDK's own auth read is allowed");
    assert.notStrictEqual((await get("/book?token_id=1")).status, 403, "market reads stay open");
    const builderKey = await get("/auth/builder-api-key");
    assert.strictEqual(builderKey.status, 403, "our builder's own key is never readable by a client");
    assert.strictEqual(((await builderKey.json()) as { error: string }).error, "path_not_allowed");

    console.log("OK: the first envelope backfills the signer, once, without loosening the binding");
    console.log("PASS: builder-sign");
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
