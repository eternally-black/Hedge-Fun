// DB-backed self-check for the REAL tokenized-stock buy path (src/lib/stocks-real.ts + the four
// /api/stocks routes). Same style as scripts/test-hedge-wallet-verified.ts — node:assert, a Privy
// prototype stub, a globalThis.fetch stub keyed by URL. Upstreams (Jupiter, Helius) are stubbed;
// the DB is real. Run: npx tsx scripts/test-stocks-real-db.ts (part of test:db:run). Needs DATABASE_URL.
import assert from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { PrivyClient } from "@privy-io/server-auth";
import {
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { STOCK_TERMS_VERSION, STOCK_SPONSOR_MAX_PER_USER_PER_DAY } from "../src/lib/config";
import { USDC_MINT, type RpcParsedTx } from "../src/lib/stocks";

const RUN = `${process.pid}-${Date.now() & 0xffffff}`;
const DID = `did:privy:sr-${RUN}`;
// The payer is a REAL throwaway keypair: the sponsored path needs a wallet that can sign the tx the
// server built. sk64 = 32-byte seed + 32-byte public key (the STOCK_SPONSOR_SECRET format too).
function sk64(): Uint8Array {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const sk = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const pk = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return Uint8Array.from(Buffer.concat([sk.subarray(sk.length - 32), pk.subarray(pk.length - 32)]));
}
const USER_SECRET = sk64();
const SPONSOR_SECRET = sk64();
const PAYER = getBase58Decoder().decode(USER_SECRET.subarray(32));
const SPONSOR = getBase58Decoder().decode(SPONSOR_SECRET.subarray(32));
const SPONSOR_B58 = getBase58Decoder().decode(SPONSOR_SECRET);
// Addresses that must survive kit compilation (unlike MINT, which only ever appears in URLs and in
// the jsonParsed fixtures).
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUP_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const MINT_ADDR = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const TOKEN_ACCOUNT = "Ch4K4D2cTVNY7H7nJ2Y6byCiEeQzkE3AmGvJb1knYbTc";
const LUT = "2vtyH7Sawno2NXQr5JQYA6Qmhs14jLVo63qvnaKVZJdp";
const MINT = `mint-real-${RUN}`;
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const SIG2 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUX";
const SIG3 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUY";
const SIG4 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUZ";
const SIG5 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUa";
const SIG6 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUb";
const SIG7 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUc";
const SIG8 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUd";
const SIG9 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUe";

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

let usdcRaw = 100_000_000n; // the wallet's USDC (micro) — the buy path sizes the swap to it
// The blockhash the sponsored builder gets. Changing it makes the NEXT built tx a different message,
// which is how the tx_mismatch case gets a decodable-but-wrong transaction.
let blockhashSeed = 7;
let sent: string[] = []; // every base64 tx handed to sendTransaction
let sendSig = SIG;

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

// A landed SELL: the stock leaves (its emptied account is closed, so it is absent from the post
// balances) and USDC arrives. The PAYER is a signer but NOT key 0 — the sponsor pays the fee.
function makeSellTx(qtyBase: bigint, usdcInMicro: bigint, err: unknown = null): RpcParsedTx {
  return {
    meta: {
      err,
      preTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "1000000", decimals: 6 } },
        { accountIndex: 2, mint: MINT, owner: PAYER, uiTokenAmount: { amount: String(qtyBase), decimals: 8 } },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC_MINT,
          owner: PAYER,
          uiTokenAmount: { amount: String(1_000_000n + usdcInMicro), decimals: 6 },
        },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: SPONSOR, signer: true }, { pubkey: PAYER, signer: true }] } },
  };
}

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

// What the wallet does: sign the message the server built, nothing else.
async function signAsUser(b64: string): Promise<string> {
  const signer = await createKeyPairSignerFromBytes(USER_SECRET);
  const signed = await partiallySignTransaction([signer.keyPair], getTransactionDecoder().decode(bytes(b64)));
  return Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
}

// Is the emptied-token-account close (SPL-Token opcode 9) inside this transaction?
function hasCloseAccountIx(b64: string): boolean {
  const msg = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes(b64)).messageBytes);
  return msg.instructions.some((i) => i.data?.length === 1 && i.data[0] === 9);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("lite-api.jup.ag/swap/v1/quote")) {
    // BUY = USDC in; SELL = the stock in, USDC out. One stub, both directions.
    const buying = url.includes(`inputMint=${USDC_MINT}`);
    return json(
      buying
        ? {
            inputMint: USDC_MINT,
            outputMint: MINT,
            inAmount: "1000000",
            outAmount: "299330",
            otherAmountThreshold: "297834",
            priceImpactPct: "0.01",
            routePlan: [],
          }
        : {
            inputMint: MINT,
            outputMint: USDC_MINT,
            inAmount: "299330",
            outAmount: "1010000",
            otherAmountThreshold: "1000000",
            priceImpactPct: "0.01",
            routePlan: [],
          },
    );
  }
  // Checked BEFORE /swap: "/swap-instructions" contains "/swap".
  if (url.includes("lite-api.jup.ag/swap/v1/swap-instructions")) {
    const ix = (programId: string, accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[], data: number[]) => ({
      programId,
      accounts,
      data: Buffer.from(data).toString("base64"),
    });
    return json({
      computeBudgetInstructions: [ix("ComputeBudget111111111111111111111111111111", [], [2, 0xc0, 0x5c, 0x15, 0x00])],
      // An ATA creation whose accounts[0] is the funding payer — patchAtaPayer must move it.
      setupInstructions: [
        ix(
          ATA_PROGRAM,
          [
            { pubkey: PAYER, isSigner: true, isWritable: true },
            { pubkey: TOKEN_ACCOUNT, isSigner: false, isWritable: true },
            { pubkey: PAYER, isSigner: false, isWritable: false },
            { pubkey: MINT_ADDR, isSigner: false, isWritable: false },
            { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          ],
          [0],
        ),
      ],
      swapInstruction: ix(
        JUP_PROGRAM,
        [
          { pubkey: PAYER, isSigner: true, isWritable: true },
          { pubkey: TOKEN_ACCOUNT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        [1, 2, 3],
      ),
      cleanupInstruction: null,
      otherInstructions: [],
      addressLookupTableAddresses: [LUT],
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
    } else if (body.method === "getBalance") {
      result = { value: 7_000_000 };
    } else if (body.method === "getSignaturesForAddress") {
      result = SIGS;
    } else if (body.method === "getTokenAccountsByOwner") {
      // The buy path sizes the swap to the wallet's USDC (usdcRaw, $100 by default so every stake fits);
      // the sell/reconcile paths read the xStock balance (walletRaw).
      const mint = (body.params?.[1] as { mint?: string } | undefined)?.mint;
      const amount = mint === USDC_MINT ? String(usdcRaw) : String(walletRaw);
      result = {
        value: [
          { pubkey: TOKEN_ACCOUNT, account: { data: { parsed: { info: { tokenAmount: { amount } } } } } },
        ],
      };
    } else if (body.method === "getLatestBlockhash") {
      result = {
        value: {
          blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(blockhashSeed)),
          lastValidBlockHeight: 1000,
        },
      };
    } else if (body.method === "getAccountInfo") {
      const who = body.params[0] as string;
      if (who === LUT) {
        // 56-byte header + two addresses: what the builder compresses against.
        const buf = new Uint8Array(56 + 64);
        buf.set(new Uint8Array(32).fill(3), 56);
        buf.set(new Uint8Array(32).fill(4), 88);
        result = { value: { data: [Buffer.from(buf).toString("base64"), "base64"], owner: "AddressLookupTab1e1111111111111111111111111" } };
      } else {
        // The MINT: its OWNER is the token program the close-account instruction must target.
        result = { value: { data: ["", "base64"], owner: TOKEN_PROGRAM } };
      }
    } else if (body.method === "sendTransaction") {
      sent.push(body.params[0] as string);
      result = sendSig;
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
  const submitRoute = await import("../src/app/api/stocks/real/submit/route");
  const sellRoute = await import("../src/app/api/stocks/real/sell-tx/route");
  const walletRoute = await import("../src/app/api/stocks/wallet/route");
  const { messageHashOf } = await import("../src/lib/sponsor");

  // The local .env may carry a real STOCK_SPONSOR_SECRET (the dev server uses one). This suite
  // drives BOTH modes explicitly, so it starts from a known state: sponsorship off.
  delete process.env.STOCK_SPONSOR_SECRET;
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
      feePayer: string | null;
      quote: { inAmountMicro: string; minOutBase: string };
    };
    assert.strictEqual(txJson.swapTransaction, Buffer.from("fake-tx").toString("base64"));
    assert.strictEqual(txJson.feePayer, null, "no sponsor key -> the wallet pays its own fee");
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

    // ── 10. Fee sponsorship OFF (no key): the self-paid path is what steps 1-9 exercised, and a real
    //       SELL simply is not offered.
    assert.strictEqual(process.env.STOCK_SPONSOR_SECRET, undefined, "steps 1-9 ran self-paid");
    const lot1 = await prisma.stockPosition.create({
      data: {
        userId,
        assetId: assetId!,
        mode: "REAL",
        source: "DECK",
        qtyBase: 299_330n,
        costCents: 100,
        entryPriceCents: 33_408,
        txSig: SIG5,
        payer: PAYER,
        walletCheckedAt: new Date(),
      },
    });
    walletRaw = 299_330n;
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lot1.id });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "sponsor_unavailable", "no key -> no real sell");

    // ── 11. Turn sponsorship ON. /real/tx now returns OUR tx: feePayer = the sponsor, the attempt is
    //       sponsored, and its msgHash is the hash of the MESSAGE inside the tx we handed back.
    process.env.STOCK_SPONSOR_SECRET = SPONSOR_B58;
    height = 900; // the sweep cases pushed the chain past every blockhash; rewind for the submits
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const spon = (await res.json()) as {
      attemptId: string;
      swapTransaction: string;
      feePayer: string | null;
      lastValidBlockHeight: number;
    };
    assert.strictEqual(spon.feePayer, SPONSOR, "the fee payer is the sponsor");
    assert.strictEqual(spon.lastValidBlockHeight, 1000);
    const sponAttempt = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: spon.attemptId } });
    assert.strictEqual(sponAttempt.sponsored, true);
    assert.strictEqual(sponAttempt.kind, "BUY");
    assert.strictEqual(sponAttempt.msgHash, messageHashOf(bytes(spon.swapTransaction)), "msgHash is the hash of the returned tx");
    // The wallet is a signer of a transaction it does not pay for.
    const slots = getTransactionDecoder().decode(bytes(spon.swapTransaction)).signatures as Record<string, Uint8Array | null>;
    assert.deepStrictEqual(Object.keys(slots).sort(), [SPONSOR, PAYER].sort(), "sponsor + user signature slots");
    assert.strictEqual(slots[PAYER], null, "unsigned when handed to the client");

    // ── 12. A tx whose MESSAGE differs is never co-signed. Same attempt, a tx built one blockhash
    //       later: it decodes, it is signed, and it is still refused — nothing is sent.
    blockhashSeed = 9;
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const other = (await res.json()) as { attemptId: string; swapTransaction: string };
    assert.notStrictEqual(other.swapTransaction, spon.swapTransaction, "a different blockhash -> a different tx");
    sent = [];
    res = await post(submitRoute, "/api/stocks/real/submit", {
      attemptId: spon.attemptId,
      signedTransaction: await signAsUser(other.swapTransaction),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "tx_mismatch");
    assert.strictEqual(sent.length, 0, "a mismatched tx is NEVER sent");

    // The right message, unsigned: refused too — the sponsor never signs alone.
    res = await post(submitRoute, "/api/stocks/real/submit", { attemptId: spon.attemptId, signedTransaction: spon.swapTransaction });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "tx_mismatch", "the user signature is required");
    assert.strictEqual(sent.length, 0);

    // ── 13. The real thing: the user signs, we co-sign and send, the attempt carries the signature.
    sendSig = SIG6;
    res = await post(submitRoute, "/api/stocks/real/submit", {
      attemptId: spon.attemptId,
      signedTransaction: await signAsUser(spon.swapTransaction),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(((await res.json()) as { sig: string }).sig, SIG6);
    assert.strictEqual(sent.length, 1, "exactly one send");
    const sentSlots = getTransactionDecoder().decode(bytes(sent[0])).signatures as Record<string, Uint8Array | null>;
    assert.strictEqual(sentSlots[PAYER]?.length, 64, "the user signature is on the wire");
    assert.strictEqual(sentSlots[SPONSOR]?.length, 64, "and so is the sponsor one");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: spon.attemptId } })).sig, SIG6);

    // A second submit of a no-longer-PENDING attempt is refused before anything is sent.
    await prisma.stockBuyAttempt.update({ where: { id: spon.attemptId }, data: { status: "CONFIRMED" } });
    res = await post(submitRoute, "/api/stocks/real/submit", {
      attemptId: spon.attemptId,
      signedTransaction: await signAsUser(spon.swapTransaction),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "attempt_not_pending");
    assert.strictEqual(sent.length, 1, "still one send");

    // ── 14. SELL: the attempt is kind SELL on the lot, ExactIn = the lot's own qtyBase, and the
    //       emptied token account is closed in the same tx (rent back to the sponsor).
    walletRaw = 299_330n;
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lot1.id });
    assert.strictEqual(res.status, 200);
    const sellJson = (await res.json()) as {
      attemptId: string;
      swapTransaction: string;
      feePayer: string;
      quote: { inAmountBase: string; minOutMicro: string };
    };
    assert.strictEqual(sellJson.feePayer, SPONSOR);
    assert.strictEqual(sellJson.quote.inAmountBase, "299330");
    assert.strictEqual(sellJson.quote.minOutMicro, "1000000");
    const sellAttempt = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellJson.attemptId } });
    assert.strictEqual(sellAttempt.kind, "SELL");
    assert.strictEqual(sellAttempt.positionId, lot1.id);
    assert.strictEqual(sellAttempt.sponsored, true);
    assert.strictEqual(sellAttempt.inAmountMicro, 299_330n, "SELL: inAmountMicro is the RAW stock sold");
    assert.strictEqual(sellAttempt.minOutBase, 1_000_000n, "SELL: minOutBase is the MINIMUM USDC micro out");
    assert.strictEqual(sellAttempt.stakeCents, 100, "the lot cost basis travels with the attempt");
    assert.ok(hasCloseAccountIx(sellJson.swapTransaction), "selling the whole balance closes the token account");

    // Holding MORE than the lot: the account stays open (something else lives in it).
    walletRaw = 299_330n * 2n;
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lot1.id });
    assert.strictEqual(res.status, 200);
    const sellPartial = (await res.json()) as { swapTransaction: string };
    assert.strictEqual(hasCloseAccountIx(sellPartial.swapTransaction), false, "a wallet holding more keeps its account");

    // ── 15. Confirm the sell from a landed tx whose PAYER IS A SIGNER BUT NOT KEY 0 (the sponsor
    //       pays): the lot closes with the proceeds the chain actually paid.
    TXS[SIG7] = makeSellTx(299_330n, 1_010_000n);
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellJson.attemptId, sig: SIG7 });
    assert.strictEqual(res.status, 200);
    const sold = (await res.json()) as {
      kind: string;
      positionId: string;
      qtyBase: string;
      costCents: number;
      proceedsCents: number;
      pnlCents: number;
      alreadyConfirmed: boolean;
    };
    assert.strictEqual(sold.kind, "SELL");
    assert.strictEqual(sold.positionId, lot1.id);
    assert.strictEqual(sold.qtyBase, "299330");
    assert.strictEqual(sold.costCents, 100);
    assert.strictEqual(sold.proceedsCents, 101, "1_010_000 micro FLOORs to 101 cents");
    assert.strictEqual(sold.pnlCents, 1);
    assert.strictEqual(sold.alreadyConfirmed, false);
    const closedLot1 = await prisma.stockPosition.findUniqueOrThrow({ where: { id: lot1.id } });
    assert.ok(closedLot1.closedAt, "the lot is closed");
    assert.strictEqual(closedLot1.closeReason, "sold");
    assert.strictEqual(closedLot1.sellTxSig, SIG7);
    assert.strictEqual(closedLot1.proceedsCents, 101);
    assert.strictEqual(closedLot1.pnlCents, 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellJson.attemptId } })).status, "CONFIRMED");
    const vb2 = await prisma.virtualBalance.findUnique({ where: { userId } });
    assert.strictEqual(vb2?.lockedCents ?? 0, 0, "a REAL sell touches no paper balance");

    // Replay -> the same answer, no second close.
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellJson.attemptId, sig: SIG7 });
    assert.strictEqual(res.status, 200);
    const replay = (await res.json()) as { alreadyConfirmed: boolean; positionId: string; proceedsCents: number };
    assert.strictEqual(replay.alreadyConfirmed, true);
    assert.strictEqual(replay.positionId, lot1.id);
    assert.strictEqual(replay.proceedsCents, 101);

    // ── 16. A lot the wallet no longer holds: 409 lot_moved, and the lot is closed as "wallet".
    const lot2 = await prisma.stockPosition.create({
      data: {
        userId,
        assetId: assetId!,
        mode: "REAL",
        source: "DECK",
        qtyBase: 299_330n,
        costCents: 100,
        entryPriceCents: 33_408,
        txSig: SIG8,
        payer: PAYER,
        walletCheckedAt: new Date(),
      },
    });
    walletRaw = 0n;
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lot2.id });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "lot_moved");
    const movedLot = await prisma.stockPosition.findUniqueOrThrow({ where: { id: lot2.id } });
    assert.ok(movedLot.closedAt, "the lot the wallet cannot back is closed");
    assert.strictEqual(movedLot.closeReason, "wallet");
    assert.strictEqual(movedLot.sellTxSig, null);

    // Selling a closed lot -> 409 lot_closed.
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lot2.id });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "lot_closed");

    // ── 17. The per-user daily cap on sponsored attempts (buys AND sells).
    await prisma.stockBuyAttempt.createMany({
      data: Array.from({ length: STOCK_SPONSOR_MAX_PER_USER_PER_DAY }, (_, i) => ({
        userId: userId!,
        assetId: assetId!,
        payer: PAYER,
        sponsored: true,
        stakeCents: 100,
        inAmountMicro: 1_000_000n,
        minOutBase: 297_834n,
        msgHash: `cap-${i}`,
        lastValidBlockHeight: 1000n,
      })),
    });
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(await err(res), "sponsor_limit");
    walletRaw = 299_330n;
    const lot3 = await prisma.stockPosition.create({
      data: {
        userId,
        assetId: assetId!,
        mode: "REAL",
        source: "DECK",
        qtyBase: 299_330n,
        costCents: 100,
        entryPriceCents: 33_408,
        txSig: SIG9,
        payer: PAYER,
        walletCheckedAt: new Date(),
      },
    });
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lot3.id });
    assert.strictEqual(res.status, 429, "the cap covers sells too");
    assert.strictEqual(await err(res), "sponsor_limit");

    // With the key removed the self-paid build works again — an unsponsored attempt is not capped.
    delete process.env.STOCK_SPONSOR_SECRET;
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const selfPaid = (await res.json()) as { feePayer: string | null; swapTransaction: string };
    assert.strictEqual(selfPaid.feePayer, null, "no key -> the wallet pays its own fee");
    assert.strictEqual(selfPaid.swapTransaction, Buffer.from("fake-tx").toString("base64"), "...via the plain /swap path");

    // ── 18. GET /api/stocks/wallet: only the caller's VERIFIED wallet, floored to cents.
    usdcRaw = 12_345_678n; // USDC micro
    res = await walletRoute.GET(new Request(`http://x/api/stocks/wallet?address=${PAYER}`, { headers }));
    assert.strictEqual(res.status, 200);
    const wal = (await res.json()) as { address: string; usdcCents: number; solLamports: string; sponsored: boolean };
    assert.strictEqual(wal.address, PAYER);
    assert.strictEqual(wal.usdcCents, 1234, "12_345_678 micro -> 1234 cents (floor)");
    assert.strictEqual(wal.solLamports, "7000000", "the stubbed getBalance");
    assert.strictEqual(wal.sponsored, false, "the key is off at this point");
    res = await walletRoute.GET(
      new Request("http://x/api/stocks/wallet?address=SomeOtherWallet1111111111111111111111111111", { headers }),
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(await err(res), "wallet_not_verified");

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
