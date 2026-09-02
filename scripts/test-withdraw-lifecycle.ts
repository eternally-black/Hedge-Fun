// /api/real/withdraw — the BRIDGE_OUT slot lifecycle, end to end through the real route and the real
// workflow engine. Upstreams are stubbed at their seams: the bridge (supported-assets / withdraw /
// status) and the Polygon RPC (pUSD balance) at fetch, the Polymarket SDK by scripts/stubs (a fake
// gasless generator that parks on the signature request, a relayer probe that is unreachable),
// seeded into require.cache. Every other URL is an outage. The arms that had live bugs:
//   - a run parked in PENDING_SIGNATURE is superseded, never a 409 (a rejected prompt used to hold
//     the slot forever);
//   - a run with the same destination REUSES its bridge address — never a second mint (a bridge
//     address is a live one-shot forwarder);
//   - a SUBMITTING run without a relayer verdict keeps the slot even when the balance dropped
//     (resetNeedsProof: a queued transfer reads exactly like one that never left);
//   - a new destination mints a new address; the validation gates refuse before any mint.
// The route allows 6 POSTs per user per minute; each user below stays at 5 or fewer.
// Run: npx tsx scripts/test-withdraw-lifecycle.ts (part of test:db:run). Needs DATABASE_URL.
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import sdkStub from "./stubs/polymarket-client-hooks.cjs";
import { randomCode } from "../src/lib/refcode";
import { REAL_TERMS_VERSION } from "../src/lib/real-terms";

const TAG = `${process.pid}-${Date.now() & 0xffffff}`;
// alice: mint / supersede / reuse / new destination; bob: the validation gates; carol: SUBMITTING.
const DIDS = [`did:privy:wd-a-${TAG}`, `did:privy:wd-b-${TAG}`, `did:privy:wd-c-${TAG}`];
let currentDid = DIDS[0];
(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: currentDid };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => ({
  email: { address: `${currentDid}@test.local` },
  twitter: null,
  wallet: null,
  linkedAccounts: [],
});

// Everything the route needs to get past its configuration gates. POLYGON_RPC_URL is read at
// module load by polygon.ts, so it must be set before the dynamic imports below.
process.env.REAL_CREDS_KEY = "a".repeat(64);
process.env.APP_ORIGIN = "https://app.test";
process.env.POLYMARKET_BUILDER_API_KEY = "builder-key";
process.env.POLYMARKET_BUILDER_SECRET = "builder-secret";
process.env.POLYMARKET_BUILDER_PASSPHRASE = "builder-pass";
process.env.POLYMARKET_BUILDER_CODE = "hedgefun-test";
process.env.POLYGON_RPC_URL = "http://rpc.test";

// Valid base58 32-byte Solana addresses (well-known program/mint ids — the route only validates shape).
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT_A = "So11111111111111111111111111111111111111112";
const RECIPIENT_B = "11111111111111111111111111111111";
const SOL_CHAIN = "1151111081099710";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// ── upstream stubs ────────────────────────────────────────────────────────────────────────────────
let pusdMicro = 5_000_000n; // what the RPC reports for every deposit wallet
let mints = 0;
const mintedAddress = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const unexpected: string[] = [];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://bridge.polymarket.com/supported-assets") {
    return json({
      supportedAssets: [
        { chainId: SOL_CHAIN, chainName: "Solana", minCheckoutUsd: 1, token: { symbol: "USDC", address: USDC_MINT, decimals: 6 } },
        { chainId: "8453", chainName: "Base", minCheckoutUsd: 1, token: { symbol: "USDC", address: BASE_USDC, decimals: 6 } },
      ],
    });
  }
  if (url === "https://bridge.polymarket.com/withdraw") {
    mints++;
    return json({ address: { evm: mintedAddress(mints) } });
  }
  if (url.startsWith("https://bridge.polymarket.com/status/")) return json({ transactions: [] });
  if (url === "http://rpc.test") {
    const method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
    if (method !== "eth_call") unexpected.push(`rpc ${method}`);
    return json({ jsonrpc: "2.0", id: 1, result: `0x${pusdMicro.toString(16).padStart(64, "0")}` });
  }
  unexpected.push(url);
  throw new Error(`stubbed outage: ${url}`);
}) as typeof fetch;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { saveClobCreds } = await import("../src/lib/clob-creds");
  const route = await import("../src/app/api/real/withdraw/route");

  const users: Array<{ id: string; embeddedWalletAddress: string | null }> = [];
  const post = (body: unknown) =>
    route.POST(
      new Request("http://x/api/real/withdraw", {
        method: "POST",
        headers: { authorization: "Bearer good", "content-type": "application/json", origin: "https://app.test" },
        body: JSON.stringify(body),
      }),
    );
  const get = () => route.GET(new Request("http://x/api/real/withdraw", { headers: { authorization: "Bearer good" } }));
  const row = (userId: string) =>
    prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId, kind: "BRIDGE_OUT" } } });
  const setRow = (userId: string, data: Record<string, unknown>) =>
    prisma.walletWorkflow.update({ where: { userId_kind: { userId, kind: "BRIDGE_OUT" } }, data });
  const toSolana = (recipient: string, amountMicro = "2000000") => ({ chainId: SOL_CHAIN, tokenAddress: USDC_MINT, recipient, amountMicro });
  type Started = { bridgeAddress: string; amountMicro: string; status: string; runId?: string; request?: { kind: string } };

  try {
    for (const [i, did] of DIDS.entries()) {
      const u = await prisma.user.create({
        data: {
          privyId: did,
          email: `${did}@test.local`,
          authProvider: "EMAIL",
          referralCode: randomCode(),
          realConsentAt: new Date(),
          realConsentVersion: REAL_TERMS_VERSION,
          embeddedWalletAddress: `0x${(BigInt(Date.now()) * 100n + BigInt(i)).toString(16).padStart(40, "1")}`.toLowerCase(),
          depositWalletAddress: `0x${(BigInt(Date.now()) * 100n + BigInt(i)).toString(16).padStart(40, "2")}`.toLowerCase(),
        },
      });
      users.push(u);
      assert.ok(await saveClobCreds(prisma, u.id, { key: "k-1234", secret: "c2VjcmV0LXZhbHVl", passphrase: "pass-phrase-1234" }));
    }
    const [alice, bob, carol] = users;

    // ── validation gates refuse before any mint (bob, 5 posts) ─────────────────────────────────
    currentDid = DIDS[1];
    const cases: Array<[unknown, number, string]> = [
      [toSolana("0x" + "ab".repeat(20)), 400, "wrong_chain_recipient"], // EVM recipient for a Solana asset
      [toSolana("So1111"), 400, "bad_recipient"], // not a 32-byte base58 address
      [toSolana(RECIPIENT_A, "9000000"), 409, "insufficient_balance"],
      [toSolana(RECIPIENT_A, "500000"), 409, "below_minimum"], // the BRIDGE's floor, minUsd 1
      [{ chainId: "1", tokenAddress: "0x" + "00".repeat(20), recipient: RECIPIENT_A }, 400, "unsupported_asset"],
    ];
    for (const [body, status, error] of cases) {
      const res = await post(body);
      assert.strictEqual(res.status, status, `${error}: status`);
      assert.strictEqual(((await res.json()) as { error: string }).error, error);
    }
    assert.strictEqual(mints, 0, "a refused request never mints a bridge address");
    assert.strictEqual(await prisma.walletWorkflow.count({ where: { userId: bob.id } }), 0, "and never opens a run");

    // ── 1. first withdrawal: one mint, a run parked on the device signature (alice, post 1) ─────
    currentDid = DIDS[0];
    let res = await post(toSolana(RECIPIENT_A));
    assert.strictEqual(res.status, 200, "first withdrawal accepted");
    let body = (await res.json()) as Started;
    assert.strictEqual(body.status, "pending_signature", "the run parks on the signature request");
    assert.strictEqual(body.request?.kind, "signTypedData");
    assert.strictEqual(body.bridgeAddress, mintedAddress(1), "the minted bridge address is returned");
    assert.strictEqual(body.amountMicro, "2000000");
    assert.strictEqual(mints, 1);
    assert.strictEqual(sdkStub.__stubCalls.prepared, 1, "one gasless run prepared");
    let r = await row(alice.id);
    assert.strictEqual(r.state, "PENDING_SIGNATURE");
    assert.ok(r.pendingRequestHash, "the parked request is persisted for the device answer");
    const firstRunId = r.runId;
    const inputs = r.inputs as { bridgeAddress: string; pusdBaseline: string; amountMicro: string; recipient: string };
    assert.strictEqual(inputs.bridgeAddress, mintedAddress(1), "the run records the address it was minted for");
    assert.strictEqual(inputs.pusdBaseline, "5000000", "the baseline is the balance read at POST time");
    assert.strictEqual(inputs.recipient, RECIPIENT_A);

    // ── 2. same destination while parked: superseded (never 409), address REUSED (alice, post 2) ─
    res = await post(toSolana(RECIPIENT_A));
    assert.strictEqual(res.status, 200, "an abandoned signature prompt does not hold the slot");
    body = await res.json();
    assert.strictEqual(body.status, "pending_signature", "a fresh run is parked in its place");
    assert.strictEqual(body.bridgeAddress, mintedAddress(1), "same destination reuses the live forwarder");
    assert.strictEqual(mints, 1, "no second mint for the same destination");
    assert.strictEqual(sdkStub.__stubCalls.prepared, 2, "a new run was prepared");
    r = await row(alice.id);
    assert.strictEqual(r.state, "PENDING_SIGNATURE");
    assert.notStrictEqual(r.runId, firstRunId, "the abandoned run was replaced");

    // ── 3. a NEW destination after a terminal run mints a new address (alice, post 3) ───────────
    await setRow(alice.id, { state: "FAILED", error: "test: terminal", txHash: null });
    res = await post(toSolana(RECIPIENT_B));
    assert.strictEqual(res.status, 200);
    body = await res.json();
    assert.strictEqual(body.bridgeAddress, mintedAddress(2), "a different recipient needs its own forwarder");
    assert.strictEqual(body.status, "pending_signature");
    assert.strictEqual(mints, 2);

    // ── GET: the card's read — row + withdrawal + a status that was READ (empty list, not outage) ─
    const g = await get();
    assert.strictEqual(g.status, 200);
    const view = (await g.json()) as {
      workflow: { kind: string; state: string } | null;
      withdrawal: { bridgeAddress: string; recipient: string; status: string | null; statusRead: boolean } | null;
      connected: { evm: string | null; solana: string | null };
      assets: unknown[];
    };
    assert.strictEqual(view.workflow?.kind, "BRIDGE_OUT");
    assert.strictEqual(view.workflow?.state, "PENDING_SIGNATURE");
    assert.strictEqual(view.withdrawal?.bridgeAddress, mintedAddress(2));
    assert.strictEqual(view.withdrawal?.recipient, RECIPIENT_B);
    assert.strictEqual(view.withdrawal?.statusRead, true, "an empty transactions list is a READ, not an outage");
    assert.strictEqual(view.withdrawal?.status, null);
    assert.strictEqual(view.connected.evm, alice.embeddedWalletAddress);
    assert.strictEqual(view.connected.solana, null, "no verified hedge wallet -> nothing autofilled");
    assert.strictEqual(view.assets.length, 2);

    // ── 4. SUBMITTING keeps the slot: no relayer handle, balance dropped, probe unreachable (carol) ─
    currentDid = DIDS[2];
    res = await post(toSolana(RECIPIENT_A)); // carol, post 1: her own run, then parked
    assert.strictEqual(res.status, 200);
    assert.strictEqual(mints, 3);
    await setRow(carol.id, { state: "SUBMITTING", runId: "run-inflight", txHash: null, expiresAt: new Date(Date.now() + 60_000) });
    res = await post(toSolana(RECIPIENT_A)); // post 2
    assert.strictEqual(res.status, 409, "a run in flight refuses a second withdrawal");
    assert.strictEqual(((await res.json()) as { error: string }).error, "withdrawal_in_flight");
    assert.strictEqual(sdkStub.__stubCalls.fetched, 0, "without a relayer handle there is nothing to probe");
    pusdMicro = 3_000_000n; // baseline - amount: the balance predicate alone would say "landed"
    res = await post(toSolana(RECIPIENT_A)); // post 3
    assert.strictEqual(res.status, 409, "resetNeedsProof: a balance drop is not proof — a queued transfer looks the same");
    await setRow(carol.id, { txHash: `stub-tx-${TAG}` });
    res = await post(toSolana(RECIPIENT_A)); // post 4
    assert.strictEqual(res.status, 409, "an unreachable relayer probe is not a verdict either");
    assert.strictEqual(sdkStub.__stubCalls.fetched, 1, "the handle was probed once");
    r = await row(carol.id);
    assert.strictEqual(r.state, "SUBMITTING", "the slot is untouched");
    assert.strictEqual(r.runId, "run-inflight");
    assert.strictEqual(mints, 3, "nothing minted while a run is in flight");
    pusdMicro = 5_000_000n;

    assert.deepStrictEqual(unexpected, [], `nothing but the bridge and eth_call was called: ${unexpected.join(", ")}`);
    console.log(
      "✓ test-withdraw-lifecycle: gates refuse before a mint, a parked run is superseded and its forwarder reused, a new destination mints, SUBMITTING holds without proof",
    );
  } finally {
    for (const u of users) {
      await prisma.walletWorkflow.deleteMany({ where: { userId: u.id } });
      await prisma.relayerTx.deleteMany({ where: { userId: u.id } });
      await prisma.clobCredential.deleteMany({ where: { userId: u.id } });
      await prisma.user.deleteMany({ where: { id: u.id } });
    }
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
