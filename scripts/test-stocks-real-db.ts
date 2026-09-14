// DB-backed self-check for the REAL tokenized-stock buy path (src/lib/stocks-real.ts + the four
// /api/stocks routes). Same style as scripts/test-hedge-wallet-verified.ts — node:assert, a Privy
// prototype stub, a globalThis.fetch stub keyed by URL. Upstreams (Jupiter, Helius) are stubbed;
// the DB is real. Run: npx tsx scripts/test-stocks-real-db.ts (part of test:db:run). Needs DATABASE_URL.
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";
import { STOCK_TERMS_VERSION } from "../src/lib/config";
import { USDC_MINT, type RpcParsedTx } from "../src/lib/stocks";

const RUN = `${process.pid}-${Date.now() & 0xffffff}`;
const DID = `did:privy:sr-${RUN}`;
const PAYER = "So11111111111111111111111111111111111111112"; // a valid base58 32-byte address
const MINT = `mint-real-${RUN}`;
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const SIG2 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUX";
const SIG3 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUY";
const SIG4 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUZ";

(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: DID };
  throw new Error("bad token");
};
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => ({
  email: { address: `${DID}@test.local` },
  twitter: null,
  wallet: null,
  linkedAccounts: [{ type: "wallet", chainType: "solana", walletClientType: "phantom", address: PAYER }],
});

process.env.HELIUS_API_KEY = "test";

// Mutable fixtures the fetch stub reads.
const TXS: Record<string, RpcParsedTx | null> = {};
let SIGS: { signature: string; blockTime: number | null; err: unknown }[] = [];
let height = 900;
let walletRaw = 0n;

function makeTx(usdcSpendMicro: bigint, qtyBase: bigint, err: unknown = null): RpcParsedTx {
  return {
    meta: {
      err,
      preTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "5000000", decimals: 6 } },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: PAYER,
          uiTokenAmount: { amount: String(5_000_000n - usdcSpendMicro), decimals: 6 },
        },
        { accountIndex: 2, mint: MINT, owner: PAYER, uiTokenAmount: { amount: String(qtyBase), decimals: 8 } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: "Other" }] } },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("lite-api.jup.ag/swap/v1/quote")) {
    return json({
      inputMint: USDC_MINT,
      outputMint: MINT,
      inAmount: "1000000",
      outAmount: "299330",
      otherAmountThreshold: "297834",
      priceImpactPct: "0.01",
      routePlan: [],
    });
  }
  if (url.includes("lite-api.jup.ag/swap/v1/swap")) {
    return json({ swapTransaction: Buffer.from("fake-tx").toString("base64"), lastValidBlockHeight: 1000 });
  }
  if (url.includes("mainnet.helius-rpc.com")) {
    const body = JSON.parse((init?.body as string) ?? "{}") as { method: string; params: unknown[] };
    let result: unknown;
    if (body.method === "getTransaction") {
      result = TXS[body.params[0] as string] ?? null;
    } else if (body.method === "getBlockHeight") {
      result = height;
    } else if (body.method === "getSignaturesForAddress") {
      result = SIGS;
    } else if (body.method === "getTokenAccountsByOwner") {
      result = { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(walletRaw) } } } } } }] };
    } else {
      throw new Error(`unexpected rpc method: ${body.method}`);
    }
    return json({ jsonrpc: "2.0", id: 1, result });
  }
  throw new Error(`stubbed outage: ${url}`);
}) as typeof fetch;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const me = await import("../src/app/api/me/route");
  const consent = await import("../src/app/api/stocks/consent/route");
  const txRoute = await import("../src/app/api/stocks/real/tx/route");
  const sentRoute = await import("../src/app/api/stocks/real/sent/route");
  const confirmRoute = await import("../src/app/api/stocks/real/confirm/route");
  const { confirmAttempt, sweepAttempts, reconcileRealLots } = await import("../src/lib/stocks-real");

  let userId: string | null = null;
  let assetId: string | null = null;
  const headers = { authorization: "Bearer good", "content-type": "application/json" };
  const post = (route: { POST: (r: Request) => Promise<Response> }, path: string, body: unknown) =>
    route.POST(new Request(`http://x${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  const err = async (res: Response) => ((await res.json()) as { error: string }).error;

  try {
    // Seed: user via GET /api/me (route handler), a verified hedge wallet, one StockAsset.
    assert.strictEqual((await me.GET(new Request("http://x/api/me", { headers }))).status, 200);
    const user = await prisma.user.findUniqueOrThrow({ where: { privyId: DID } });
    userId = user.id;

    await prisma.hedgeWallet.create({ data: { userId, address: PAYER, verifiedAt: new Date() } });
    const asset = await prisma.stockAsset.create({
      data: { mint: MINT, symbol: `RLx-${RUN}`, name: "Real xStock", underlying: "RL", decimals: 8, priceCents: 33416 },
    });
    assetId = asset.id;

    // 1. /real/tx before consent -> 403 stock_consent_required.
    let res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(await err(res), "stock_consent_required");

    // 2. Consent: wrong version -> 400; correct -> 200.
    res = await post(consent, "/api/stocks/consent", { version: STOCK_TERMS_VERSION + 1 });
    assert.strictEqual(res.status, 400);
    res = await post(consent, "/api/stocks/consent", { version: STOCK_TERMS_VERSION });
    assert.strictEqual(res.status, 200);

    // 3. /real/tx: unverified payer -> 403; verified -> 200 with the fixture quote.
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: "SomeOtherWallet1111111111111111111111111111" });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(await err(res), "wallet_not_verified");

    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const txJson = (await res.json()) as {
      attemptId: string;
      swapTransaction: string;
      lastValidBlockHeight: number;
      quote: { inAmountMicro: string; minOutBase: string };
    };
    assert.strictEqual(txJson.swapTransaction, Buffer.from("fake-tx").toString("base64"));
    assert.strictEqual(txJson.quote.inAmountMicro, "1000000");
    assert.strictEqual(txJson.quote.minOutBase, "297834");
    const attemptId = txJson.attemptId;
    const attemptRow = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    assert.strictEqual(attemptRow.status, "PENDING");
    assert.strictEqual(attemptRow.inAmountMicro, 1_000_000n);
    assert.strictEqual(attemptRow.minOutBase, 297_834n);
    assert.strictEqual(attemptRow.lastValidBlockHeight, 1000n);

    // 4. Confirm while nothing has landed -> tx_not_found (lib call, no polling delay).
    await assert.rejects(
      () => confirmAttempt(userId!, attemptId, SIG, { polls: 1, sleepMs: 0 }),
      (e: Error) => e.name === "TxNotFoundError",
    );

    // 5. Land the tx, stamp the sig, confirm -> lot booked.
    TXS[SIG] = makeTx(1_000_000n, 299_330n);
    res = await post(sentRoute, "/api/stocks/real/sent", { attemptId, sig: SIG });
    assert.strictEqual(res.status, 200);
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId, sig: SIG });
    assert.strictEqual(res.status, 200);
    const confirmJson = (await res.json()) as { positionId: string; qtyBase: string; costCents: number; alreadyConfirmed: boolean };
    assert.strictEqual(confirmJson.qtyBase, "299330");
    assert.strictEqual(confirmJson.costCents, 100);
    assert.strictEqual(confirmJson.alreadyConfirmed, false);
    const lot = await prisma.stockPosition.findUniqueOrThrow({ where: { id: confirmJson.positionId } });
    assert.strictEqual(lot.mode, "REAL");
    assert.strictEqual(lot.source, "DECK");
    assert.strictEqual(lot.txSig, SIG);
    assert.strictEqual(lot.payer, PAYER);
    assert.strictEqual(lot.attemptId, attemptId);
    assert.strictEqual(lot.entryPriceCents, 33408);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status, "CONFIRMED");
    const vb = await prisma.virtualBalance.findUnique({ where: { userId } });
    assert.strictEqual(vb?.lockedCents ?? 0, 0, "no paper hold for a REAL buy");

    // 6. Confirm again -> alreadyConfirmed, same positionId, still ONE lot.
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId, sig: SIG });
    assert.strictEqual(res.status, 200);
    const again = (await res.json()) as { positionId: string; alreadyConfirmed: boolean };
    assert.strictEqual(again.alreadyConfirmed, true);
    assert.strictEqual(again.positionId, confirmJson.positionId);
    assert.strictEqual(await prisma.stockPosition.count({ where: { userId, mode: "REAL" } }), 1);

    // 7. A second attempt: a fixture that spends MORE than signed -> 409 not_this_buy, still PENDING;
    //    a third with meta.err -> 409 tx_failed, attempt FAILED.
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const attempt2 = ((await res.json()) as { attemptId: string }).attemptId;
    TXS[SIG2] = makeTx(1_000_001n, 299_330n);
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: attempt2, sig: SIG2 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "not_this_buy");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attempt2 } })).status, "PENDING");

    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const attempt3 = ((await res.json()) as { attemptId: string }).attemptId;
    TXS[SIG3] = makeTx(1_000_000n, 299_330n, { InstructionError: [0, "Custom"] });
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: attempt3, sig: SIG3 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "tx_failed");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attempt3 } })).status, "FAILED");

    // 8. sweepAttempts.
    const mkOld = (msgHash: string) =>
      prisma.stockBuyAttempt.create({
        data: {
          userId: userId!,
          assetId: assetId!,
          payer: PAYER,
          stakeCents: 100,
          inAmountMicro: 1_000_000n,
          minOutBase: 297_834n,
          msgHash,
          lastValidBlockHeight: 1000n,
          createdAt: new Date(Date.now() - 10 * 60_000),
        },
      });
    // 8a. Old PENDING, no sig, height < lastValidBlockHeight -> left PENDING.
    const oldAttempt = await mkOld("old");
    height = 900;
    let sweep = await sweepAttempts();
    assert.ok(sweep.scanned >= 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: oldAttempt.id } })).status, "PENDING");

    // 8b. height > lastValidBlockHeight, no matching sigs -> EXPIRED.
    height = 2000;
    SIGS = [];
    sweep = await sweepAttempts();
    assert.ok(sweep.expired >= 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: oldAttempt.id } })).status, "EXPIRED");

    // 8c. Another old attempt with a matching sig in SIGS -> CONFIRMED with a lot.
    const oldAttempt2 = await mkOld("old2");
    TXS[SIG4] = makeTx(1_000_000n, 299_330n);
    SIGS = [{ signature: SIG4, blockTime: Math.floor(Date.now() / 1000), err: null }];
    sweep = await sweepAttempts();
    assert.ok(sweep.confirmed >= 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: oldAttempt2.id } })).status, "CONFIRMED");
    const sweptLot = await prisma.stockPosition.findUniqueOrThrow({ where: { attemptId: oldAttempt2.id } });
    assert.strictEqual(sweptLot.qtyBase, 299_330n);

    // 9. reconcileRealLots: two REAL lots open (confirmed + swept).
    walletRaw = 299_330n * 2n;
    let rec = await reconcileRealLots(userId!, PAYER);
    assert.strictEqual(rec.closed, 0);
    const openLots = await prisma.stockPosition.findMany({ where: { userId, mode: "REAL", closedAt: null } });
    assert.strictEqual(openLots.length, 2);
    for (const l of openLots) assert.ok(l.walletCheckedAt !== null);

    walletRaw = 299_330n;
    rec = await reconcileRealLots(userId!, PAYER);
    assert.strictEqual(rec.closed, 1, "one lot closed when the wallet backs only one");
    const closedLot = await prisma.stockPosition.findFirstOrThrow({ where: { userId, mode: "REAL", closedAt: { not: null } } });
    assert.strictEqual(closedLot.closeReason, "wallet");
    assert.strictEqual(closedLot.id, sweptLot.id, "the NEWEST lot is closed first");

    walletRaw = 0n;
    rec = await reconcileRealLots(userId!, PAYER);
    assert.strictEqual(rec.closed, 1);
    assert.strictEqual(await prisma.stockPosition.count({ where: { userId, mode: "REAL", closedAt: null } }), 0);

    console.log("test-stocks-real-db: OK");
  } finally {
    if (userId) {
      const userIds = [userId];
      await prisma.stockPosition.deleteMany({ where: { userId } });
      await prisma.stockBuyAttempt.deleteMany({ where: { userId } });
      await prisma.hedgeWallet.deleteMany({ where: { userId } });
      await prisma.shardGrant.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.bet.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.pointsLedger.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.loginMark.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.dailyCounter.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.streakEvent.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.streak.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.collectibleBalance.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.virtualBalance.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (assetId) await prisma.stockAsset.deleteMany({ where: { id: assetId } });
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
