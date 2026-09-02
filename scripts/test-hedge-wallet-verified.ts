// Hedge-wallet ownership (S5): a Solana address the user LINKED through Privy (it signed Privy's
// challenge) is verified at link time; a pasted address is not; verification only ratchets up; and
// the withdraw form's Solana autofill (/api/real/withdraw GET connected.solana) offers ONLY a
// verified wallet — a money destination must never come from a paste. A Privy outage never refuses
// a link, it just cannot verify it. Upstreams (Privy, Helius/Jupiter, the bridge) are stubbed; the
// exposure fetch 502s, which is fine — the link and its verification land before it; the wire flag
// is read through the returning-user GET against a cached snapshot row.
// Run: npx tsx scripts/test-hedge-wallet-verified.ts (part of test:db:run). Needs DATABASE_URL.
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import "./stubs/polymarket-client-hooks.cjs"; // the withdraw route's import graph pulls the SDK
import { randomCode } from "../src/lib/refcode";
import { REAL_TERMS_VERSION } from "../src/lib/real-terms";

const DID = `did:privy:hw-${process.pid}-${Date.now() & 0xffffff}`;
const LINKED = "So11111111111111111111111111111111111111112"; // linked through Privy (signed)
const PASTED = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // typed into the form
const PASTED_DURING_OUTAGE = "11111111111111111111111111111111";
const EMBEDDED = `0x${(Date.now() % 1e12).toString(16).padStart(40, "3")}`;

let privyDown = false;
(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: DID };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => {
  if (privyDown) throw new Error("privy unavailable");
  return {
    email: { address: `${DID}@test.local` },
    twitter: null,
    wallet: null,
    linkedAccounts: [
      { type: "wallet", chainType: "ethereum", walletClientType: "privy", address: EMBEDDED },
      { type: "wallet", chainType: "solana", walletClientType: "phantom", address: LINKED },
    ],
  };
};

// No exposure upstream in this test: every external call is an outage.
process.env.HELIUS_API_KEY = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`stubbed outage: ${url}`);
}) as typeof fetch;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const hedge = await import("../src/app/api/hedge/wallet/route");
  const withdraw = await import("../src/app/api/real/withdraw/route");

  let userId: string | null = null;
  const snapshots: string[] = [];
  const headers = { authorization: "Bearer good", "content-type": "application/json" };
  const link = (address: string) =>
    hedge.POST(new Request("http://x/api/hedge/wallet", { method: "POST", headers, body: JSON.stringify({ address }) }));
  const state = async () => {
    const res = await hedge.GET(new Request("http://x/api/hedge/wallet", { headers }));
    assert.strictEqual(res.status, 200);
    return (await res.json()) as { walletLinked: boolean; exposure: { address: string; verified: boolean } | null };
  };
  const autofill = async () => {
    const res = await withdraw.GET(new Request("http://x/api/real/withdraw", { headers }));
    assert.strictEqual(res.status, 200);
    return ((await res.json()) as { connected: { evm: string | null; solana: string | null } }).connected;
  };
  // A cached exposure for `address`, so the returning-user GET has something to report the flag on.
  const cacheSnapshot = async (address: string) => {
    await prisma.walletSnapshot.upsert({
      where: { address },
      create: { address, exposure: { majors: [], splAggregateCents: 0 }, totalNotionalCents: 0 },
      update: { fetchedAt: new Date() },
    });
    snapshots.push(address);
  };

  try {
    const user = await prisma.user.create({
      data: {
        privyId: DID,
        email: `${DID}@test.local`,
        authProvider: "EMAIL",
        referralCode: randomCode(),
        realConsentAt: new Date(),
        realConsentVersion: REAL_TERMS_VERSION,
        embeddedWalletAddress: EMBEDDED.toLowerCase(),
      },
    });
    userId = user.id;
    const wallet = (address: string) =>
      prisma.hedgeWallet.findUniqueOrThrow({ where: { userId_address: { userId: user.id, address } } });

    // 1. A Privy-linked address is verified at link time (the exposure fetch 502s — separate concern).
    let res = await link(LINKED);
    assert.strictEqual(res.status, 502, "no exposure upstream -> 502, the link itself landed");
    const linkedAt = (await wallet(LINKED)).verifiedAt;
    assert.ok(linkedAt !== null, "a Privy-linked wallet is verified");

    // 2. A pasted address links (read-only hedging still works) but is NOT verified.
    res = await link(PASTED);
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await wallet(PASTED)).verifiedAt, null, "a typed address proves nothing");

    // 3. A Privy outage never refuses the link — it just cannot verify it.
    privyDown = true;
    res = await link(PASTED_DURING_OUTAGE);
    assert.strictEqual(res.status, 502, "link during a Privy outage still lands");
    assert.strictEqual((await wallet(PASTED_DURING_OUTAGE)).verifiedAt, null);

    // 4. Verification ratchets up, never down: re-linking the verified address while Privy cannot
    //    answer keeps the earlier proof, timestamp and all.
    await new Promise((r) => setTimeout(r, 5));
    res = await link(LINKED);
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await wallet(LINKED)).verifiedAt?.getTime(), linkedAt!.getTime(), "the proof is kept, untouched");
    privyDown = false;

    // 5. The withdraw form autofills ONLY the verified wallet — the newest link is a paste and is
    //    not a money destination.
    let c = await autofill();
    assert.strictEqual(c.solana, LINKED, "autofill offers the verified wallet only");
    assert.strictEqual(c.evm, EMBEDDED.toLowerCase());

    // 6. The wire flag: the returning-user GET reports the PRIMARY (newest) wallet's stored flag.
    await cacheSnapshot(PASTED_DURING_OUTAGE); // newest link = the paste
    let s = await state();
    assert.strictEqual(s.walletLinked, true);
    assert.strictEqual(s.exposure?.address, PASTED_DURING_OUTAGE);
    assert.strictEqual(s.exposure?.verified, false, "a paste reads unverified on the wire");
    await prisma.hedgeWallet.deleteMany({ where: { userId: user.id, address: { not: LINKED } } });
    await cacheSnapshot(LINKED);
    s = await state();
    assert.strictEqual(s.exposure?.address, LINKED);
    assert.strictEqual(s.exposure?.verified, true, "the Privy-linked wallet reads verified on the wire");

    // 7. With no verified wallet at all, nothing is offered.
    await prisma.hedgeWallet.updateMany({ where: { userId: user.id }, data: { verifiedAt: null } });
    c = await autofill();
    assert.strictEqual(c.solana, null, "no verified wallet -> nothing autofilled");

    console.log(
      "✓ test-hedge-wallet-verified: Privy-linked wallet verified, a paste is not, an outage never refuses, the proof ratchets, the wire flag is the stored one, withdraw autofill offers verified only",
    );
  } finally {
    if (userId) await prisma.hedgeWallet.deleteMany({ where: { userId } });
    if (snapshots.length) await prisma.walletSnapshot.deleteMany({ where: { address: { in: snapshots } } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    globalThis.fetch = realFetch;
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });
