// DB-backed self-check for the REAL tokenized-stock buy path (src/lib/stocks-real.ts + the four
// /api/stocks routes). Same style as scripts/test-hedge-wallet-verified.ts — node:assert, a Privy
// prototype stub, a globalThis.fetch stub keyed by URL. Upstreams (Jupiter, Helius) are stubbed;
// the DB is real. Run: npx tsx scripts/test-stocks-real-db.ts (part of test:db:run). Needs DATABASE_URL.
import assert from "node:assert";
import { createHash, generateKeyPairSync } from "node:crypto";
import { PrivyClient } from "@privy-io/server-auth";
import {
  address,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Decoder,
  getCompiledTransactionMessageCodec,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
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
// Addresses that must survive kit compilation — the MINT among them: it is the ATA setup
// instruction's mint account (compiled into the sponsored tx) as well as the asset's own mint, and
// the rent-provenance rows are keyed by it. Random per run, so parallel runs never collide.
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUP_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_ACCOUNT = "Ch4K4D2cTVNY7H7nJ2Y6byCiEeQzkE3AmGvJb1knYbTc";
const LUT = "2vtyH7Sawno2NXQr5JQYA6Qmhs14jLVo63qvnaKVZJdp";
const MINT = getBase58Decoder().decode(sk64().subarray(32));
const SIG5 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUa";
const SIG8 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUd";
const SIG9 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUe";
const SIG14 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUj";
const SIG15 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUk";
const SIG18 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUo";
const SIG19 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUp";
const SIG21 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUr";
const SIG22 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUs";
const SIG23 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUt";
const SIG24 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUu";

(PrivyClient.prototype as unknown as { verifyAuthToken: unknown }).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: DID };
  throw new Error("bad token");
};
// The payer is the login's EMBEDDED wallet by default (the sponsor fronts its rent); one step flips
// it to a connected external wallet, which fronts its own.
let walletClient = "privy";
(PrivyClient.prototype as unknown as { getUser: unknown }).getUser = async () => ({
  email: { address: `${DID}@test.local` },
  twitter: null,
  wallet: null,
  linkedAccounts: [{ type: "wallet", chainType: "solana", walletClientType: walletClient, address: PAYER }],
});

process.env.HELIUS_API_KEY = "test";

// Mutable fixtures the fetch stub reads.
const TXS: Record<string, RpcParsedTx | null> = {};
type RawReceipt = { slot: number; meta: { err: unknown }; transaction: [string, "base64"] };
const RAW_TXS: Record<string, RawReceipt | null> = {};
let SIGS: { signature: string; blockTime: number | null; err: unknown }[] = [];
let height = 900;
let walletRaw = 0n;

let usdcRaw = 100_000_000n; // the wallet's USDC (micro) — the buy path sizes the swap to it
// The blockhash the sponsored builder gets. Changing it makes the NEXT built tx a different message,
// which is how the tx_mismatch case gets a decodable-but-wrong transaction.
let blockhashSeed = 7;
let sent: string[] = []; // every base64 tx handed to sendTransaction
let plainSwapSeed = 40;
let receiptSlot = 500;
// A send that fails AFTER the server has decided the signature — the case that used to leave a swap
// on chain with no row pointing at it.
let sendFails = false;
// Fired once on the sweep's getSignaturesForAddress read: the seam for "the row changed between the
// sweep's snapshot and its write".
let onSigs: (() => Promise<void>) | null = null;
// The same seam one layer down: what happens between a balance read and the decision taken off it
// (a sell confirm landing between reconcile's read and its write).
let onTokenAccounts: (() => Promise<void>) | null = null;
let getBalanceCalls = 0; // the health probe coalesces its misses — this is how we can tell

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

// Jupiter's self-paid response must still be a real wire transaction. Production hashes the
// serialized message, validates the payer's Ed25519 signature, and compares the landed raw bytes.
function unsignedSelfPaidWire(): string {
  const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(plainSwapSeed++)) as Blockhash;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(PAYER), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 1000n }, m),
  );
  return Buffer.from(getTransactionEncoder().encode(compileTransaction(message))).toString("base64");
}

function signatureOf(b64: string): string {
  return getSignatureFromTransaction(getTransactionDecoder().decode(bytes(b64)));
}

function messageHash(b64: string): string {
  return createHash("sha256").update(Buffer.from(getTransactionDecoder().decode(bytes(b64)).messageBytes)).digest("hex");
}

function landWire(wire: string, parsed: RpcParsedTx): string {
  const sig = signatureOf(wire);
  const slot = receiptSlot++;
  TXS[sig] = {
    ...parsed,
    slot,
    meta: { ...parsed.meta, err: parsed.meta?.err ?? null },
    transaction: { ...parsed.transaction, signatures: [sig] },
  };
  RAW_TXS[sig] = { slot, meta: { err: parsed.meta?.err ?? null }, transaction: [wire, "base64"] };
  return sig;
}

function replaceParsed(sig: string, parsed: RpcParsedTx): void {
  const raw = RAW_TXS[sig];
  assert.ok(raw, `raw receipt for ${sig} exists`);
  RAW_TXS[sig] = { ...raw, meta: { err: parsed.meta?.err ?? null } };
  TXS[sig] = {
    ...parsed,
    slot: raw.slot,
    meta: { ...parsed.meta, err: parsed.meta?.err ?? null },
    transaction: { ...parsed.transaction, signatures: [sig] },
  };
}

function sentWire(sig: string): string {
  const wire = sent.find((candidate) => signatureOf(candidate) === sig);
  assert.ok(wire, `a wire for ${sig} was sent`);
  return wire;
}

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

// Where the reclaimed rent goes: CloseAccount's accounts are [account, destination, owner], and both
// candidates (the sponsor = fee payer, and the user = a signer) are static accounts of the message.
function closeDestination(b64: string): string {
  const msg = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes(b64)).messageBytes);
  const ix = msg.instructions.find((i) => i.data?.length === 1 && i.data[0] === 9);
  assert.ok(ix?.accountIndices, "the close-account instruction carries its accounts");
  return msg.staticAccounts[ix!.accountIndices![1]] as string;
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
            { pubkey: MINT, isSigner: false, isWritable: false },
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
    return json({ swapTransaction: unsignedSelfPaidWire(), lastValidBlockHeight: 1000 });
  }
  if (url.includes("mainnet.helius-rpc.com")) {
    const body = JSON.parse((init?.body as string) ?? "{}") as { method: string; params: unknown[] };
    let result: unknown;
    if (body.method === "getTransaction") {
      const encoding = (body.params[1] as { encoding?: string } | undefined)?.encoding;
      result = encoding === "base64" ? RAW_TXS[body.params[0] as string] ?? null : TXS[body.params[0] as string] ?? null;
    } else if (body.method === "getBlockHeight") {
      result = height;
    } else if (body.method === "getBalance") {
      getBalanceCalls++;
      result = { value: 7_000_000 };
    } else if (body.method === "getSignaturesForAddress") {
      if (onSigs) await onSigs();
      result = SIGS;
    } else if (body.method === "getTokenAccountsByOwner") {
      if (onTokenAccounts) await onTokenAccounts();
      // The buy path sizes the swap to the wallet's USDC (usdcRaw, $100 by default so every stake fits);
      // the sell/reconcile paths read the xStock balance (walletRaw). A wallet with none of the mint
      // has NO token account at all — which is exactly when the sponsor pays the rent to open one.
      // A read by mint (sell/reconcile) or by program (adoptWalletHoldings, which reads both programs —
      // the xStock lives under Token-2022 only, so the classic program answers empty).
      const filter = body.params?.[1] as { mint?: string; programId?: string } | undefined;
      const mint = filter?.mint;
      const amount = mint === USDC_MINT ? String(usdcRaw) : String(walletRaw);
      const wrongProgram = filter?.programId !== undefined && filter.programId !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
      result = {
        context: { slot: 10_000 },
        value:
          amount === "0" || wrongProgram
            ? []
            : [{ pubkey: TOKEN_ACCOUNT, account: { data: { parsed: { info: { mint: mint ?? MINT, tokenAmount: { amount } } } } } }],
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
      if (sendFails) return json({ jsonrpc: "2.0", id: 1, error: { message: "node is behind" } });
      const wire = body.params[0] as string;
      sent.push(wire);
      result = signatureOf(wire);
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
  const { buildAttempt, buildSellAttempt, submitSigned, confirmAttempt, sweepAttempts, reconcileRealLots, adoptWalletHoldings } = await import(
    "../src/lib/stocks-real"
  );

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
    assert.strictEqual(txJson.feePayer, null, "no sponsor key -> the wallet pays its own fee");
    assert.strictEqual(txJson.quote.inAmountMicro, "1000000");
    assert.strictEqual(txJson.quote.minOutBase, "297834");
    const attemptId = txJson.attemptId;
    const attemptRow = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    assert.strictEqual(attemptRow.unsignedTx, txJson.swapTransaction, "the exact unsigned wire is retained");
    assert.strictEqual(attemptRow.msgHash, messageHash(txJson.swapTransaction), "the serialized message is hashed");
    assert.strictEqual(attemptRow.status, "PENDING");
    assert.strictEqual(attemptRow.inAmountMicro, 1_000_000n);
    assert.strictEqual(attemptRow.minOutBase, 297_834n);
    assert.strictEqual(attemptRow.lastValidBlockHeight, 1000n);

    // 4. Confirm while nothing has landed -> tx_not_found (lib call, no polling delay).
    const firstSigned = await signAsUser(txJson.swapTransaction);
    const firstSig = signatureOf(firstSigned);
    await assert.rejects(
      () => confirmAttempt(userId!, attemptId, firstSig, { polls: 1, sleepMs: 0 }),
      (e: Error) => e.name === "TxNotFoundError",
    );

    const unrelatedWire = await signAsUser(unsignedSelfPaidWire());
    const unrelatedSig = landWire(unrelatedWire, makeTx(1_000_000n, 299_330n));
    res = await post(sentRoute, "/api/stocks/real/sent", { attemptId, sig: unrelatedSig });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "not_this_buy", "/sent refuses a landed wire from another build");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).sig, null);

    // 5. The self-paid submit path stamps and broadcasts the wallet-signed wire. Once the exact raw
    //    wire lands, /sent may recover it too and confirm books the lot.
    res = await post(submitRoute, "/api/stocks/real/submit", { attemptId, signedTransaction: firstSigned });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(((await res.json()) as { sig: string }).sig, firstSig);
    assert.strictEqual(landWire(firstSigned, makeTx(1_000_000n, 299_330n)), firstSig);
    res = await post(sentRoute, "/api/stocks/real/sent", { attemptId, sig: firstSig });
    assert.strictEqual(res.status, 200);
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId, sig: firstSig });
    assert.strictEqual(res.status, 200);
    const confirmJson = (await res.json()) as { positionId: string; qtyBase: string; costCents: number; alreadyConfirmed: boolean };
    assert.strictEqual(confirmJson.qtyBase, "299330");
    assert.strictEqual(confirmJson.costCents, 100);
    assert.strictEqual(confirmJson.alreadyConfirmed, false);
    const lot = await prisma.stockPosition.findUniqueOrThrow({ where: { id: confirmJson.positionId } });
    assert.strictEqual(lot.mode, "REAL");
    assert.strictEqual(lot.source, "DECK");
    assert.strictEqual(lot.txSig, firstSig);
    assert.strictEqual(lot.payer, PAYER);
    assert.strictEqual(lot.attemptId, attemptId);
    assert.strictEqual(lot.entryPriceCents, 33408);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status, "CONFIRMED");
    const vb = await prisma.virtualBalance.findUnique({ where: { userId } });
    assert.strictEqual(vb?.lockedCents ?? 0, 0, "no paper hold for a REAL buy");

    // 6. Confirm again -> alreadyConfirmed, same positionId, still ONE lot.
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId, sig: firstSig });
    assert.strictEqual(res.status, 200);
    const again = (await res.json()) as { positionId: string; alreadyConfirmed: boolean };
    assert.strictEqual(again.alreadyConfirmed, true);
    assert.strictEqual(again.positionId, confirmJson.positionId);
    assert.strictEqual(await prisma.stockPosition.count({ where: { userId, mode: "REAL" } }), 1);

    // 7. A second attempt: a fixture that spends MORE than signed -> 409 not_this_buy, still PENDING;
    //    a third with meta.err -> 409 tx_failed, attempt FAILED.
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const secondBuild = (await res.json()) as { attemptId: string; swapTransaction: string };
    const attempt2 = secondBuild.attemptId;
    const secondSigned = await signAsUser(secondBuild.swapTransaction);
    const secondSig = await submitSigned(userId!, attempt2, secondSigned);
    landWire(secondSigned, makeTx(1_000_001n, 299_330n));
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: attempt2, sig: secondSig });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "not_this_buy");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attempt2 } })).status, "PENDING");

    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const thirdBuild = (await res.json()) as { attemptId: string; swapTransaction: string };
    const attempt3 = thirdBuild.attemptId;
    const thirdSigned = await signAsUser(thirdBuild.swapTransaction);
    const thirdSig = await submitSigned(userId!, attempt3, thirdSigned);
    landWire(thirdSigned, makeTx(1_000_000n, 299_330n, { InstructionError: [0, "Custom"] }));
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: attempt3, sig: thirdSig });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "tx_failed");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: attempt3 } })).status, "FAILED");

    // Both RPC encodings must describe the same receipt. Missing raw meta, a slot mismatch, or an
    // error mismatch fails closed as an RPC outage and leaves the attempt untouched.
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const receiptBuild = (await res.json()) as { attemptId: string; swapTransaction: string };
    const receiptSigned = await signAsUser(receiptBuild.swapTransaction);
    const receiptSig = await submitSigned(userId!, receiptBuild.attemptId, receiptSigned);
    landWire(receiptSigned, makeTx(1_000_000n, 299_330n));
    const goodRaw = RAW_TXS[receiptSig]!;

    RAW_TXS[receiptSig] = { ...goodRaw, meta: null } as unknown as RawReceipt;
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: receiptBuild.attemptId, sig: receiptSig });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(await err(res), "rpc_unavailable");

    RAW_TXS[receiptSig] = { ...goodRaw, slot: goodRaw.slot + 1 };
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: receiptBuild.attemptId, sig: receiptSig });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(await err(res), "rpc_unavailable");

    RAW_TXS[receiptSig] = { ...goodRaw, meta: { err: { InstructionError: [1, "Custom"] } } };
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: receiptBuild.attemptId, sig: receiptSig });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(await err(res), "rpc_unavailable");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: receiptBuild.attemptId } })).status, "PENDING");
    RAW_TXS[receiptSig] = goodRaw;

    // 8. sweepAttempts.
    const mkOld = async () => {
      const unsignedTx = unsignedSelfPaidWire();
      const signedTx = await signAsUser(unsignedTx);
      const attempt = await prisma.stockBuyAttempt.create({
        data: {
          userId: userId!,
          assetId: assetId!,
          payer: PAYER,
          stakeCents: 100,
          inAmountMicro: 1_000_000n,
          minOutBase: 297_834n,
          msgHash: messageHash(unsignedTx),
          unsignedTx,
          lastValidBlockHeight: 1000n,
          createdAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      return { attempt, signedTx, sig: signatureOf(signedTx) };
    };
    // 8a. Old PENDING, no sig, height < lastValidBlockHeight -> left PENDING.
    const old = await mkOld();
    const oldAttempt = old.attempt;
    height = 900;
    let sweep = await sweepAttempts();
    assert.ok(sweep.scanned >= 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: oldAttempt.id } })).status, "PENDING");

    // 8b. height > lastValidBlockHeight, no matching sigs -> EXPIRED.
    height = 2000;
    SIGS = [];
    sweep = await sweepAttempts();
    if ((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: oldAttempt.id } })).status === "PENDING") {
      // The durable cursor resets on an empty page, then the next pass wraps to the oldest row.
      sweep = await sweepAttempts();
    }
    assert.ok(sweep.expired >= 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: oldAttempt.id } })).status, "EXPIRED");

    // 8c. Another old attempt with a matching sig in SIGS -> CONFIRMED with a lot.
    const old2 = await mkOld();
    const oldAttempt2 = old2.attempt;
    landWire(old2.signedTx, makeTx(1_000_000n, 299_330n));
    SIGS = [{ signature: old2.sig, blockTime: Math.floor(Date.now() / 1000), err: null }];
    sweep = await sweepAttempts();
    assert.ok(sweep.confirmed >= 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: oldAttempt2.id } })).status, "CONFIRMED");
    const sweptLot = await prisma.stockPosition.findUniqueOrThrow({ where: { attemptId: oldAttempt2.id } });
    assert.strictEqual(sweptLot.qtyBase, 299_330n);

    // 9. reconcileRealLots: two REAL lots open (confirmed + swept).
    await prisma.stockBuyAttempt.updateMany({ where: { userId, status: "PENDING" }, data: { status: "EXPIRED" } });
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

    // 9b. adoptWalletHoldings: xStocks that arrived without us (bought in Phantom) become WALLET lots
    //     at the price of the day; never twice; and the reconcile closes an adopted lot before a booked one.
    await prisma.stockBuyAttempt.updateMany({ where: { userId, status: "PENDING" }, data: { status: "EXPIRED" } }); // clean slate: nothing in flight
    await prisma.stockAsset.update({ where: { id: assetId }, data: { priceCents: 33416, pricedAt: new Date() } });
    walletRaw = 500_000n;
    let adopt = await adoptWalletHoldings(userId!, PAYER);
    assert.strictEqual(adopt.adopted, 1, "a holding we never booked becomes a lot");
    const adoptedLot = await prisma.stockPosition.findFirstOrThrow({ where: { userId, mode: "REAL", closedAt: null, source: "WALLET" } });
    assert.strictEqual(adoptedLot.qtyBase, 500_000n, "the whole unbooked balance");
    assert.strictEqual(adoptedLot.entryPriceCents, 33416, "entered at the price of the day");
    assert.strictEqual(adoptedLot.payer, PAYER, "owned by the wallet it sits in");
    assert.ok(adoptedLot.walletCheckedAt !== null, "counts as wallet-checked");
    adopt = await adoptWalletHoldings(userId!, PAYER);
    assert.strictEqual(adopt.adopted, 0, "never adopted twice");
    walletRaw = 500_000n + 1_000n;
    adopt = await adoptWalletHoldings(userId!, PAYER);
    assert.strictEqual(adopt.adopted, 0, "dust (a third of a cent) is not a lot");
    walletRaw = 500_000n + 100_000n;
    adopt = await adoptWalletHoldings(userId!, PAYER);
    assert.strictEqual(adopt.adopted, 1, "more tokens later → one more lot for the difference");
    assert.strictEqual((await prisma.stockPosition.findFirstOrThrow({ where: { userId, source: "WALLET", closedAt: null, id: { not: adoptedLot.id } } })).qtyBase, 100_000n);
    // A NEWER booked lot and a wallet that backs only it: the adopted lots go first, the booked one stays.
    const bookedLot = await prisma.stockPosition.create({
      data: { userId, assetId, mode: "REAL", source: "DECK", qtyBase: 299_330n, costCents: 100, entryPriceCents: 33416, payer: PAYER, txSig: `booked-${RUN}` },
    });
    walletRaw = 299_330n;
    rec = await reconcileRealLots(userId!, PAYER);
    assert.strictEqual(rec.closed, 2, "both adopted lots closed");
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: adoptedLot.id } })).closeReason, "wallet", "the adopted lot is closed first");
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: bookedLot.id } })).closedAt, null, "the booked lot survives");
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

    // 11b. A CONNECTED external wallet fronts its own rent (its scanner blocks rent returning to a
    //      stranger): the setup instruction's payer is the WALLET, not the sponsor, and nothing is
    //      recorded as sponsor-funded. The fee payer is still the sponsor.
    await prisma.stockBuyAttempt.update({ where: { id: spon.attemptId }, data: { status: "EXPIRED" } });
    walletClient = "phantom";
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200, "external wallet: tx built");
    const ext = (await res.json()) as { attemptId: string; swapTransaction: string };
    {
      const m = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes(ext.swapTransaction)).messageBytes);
      const ata = m.instructions.find((ix) => m.staticAccounts[ix.programAddressIndex] === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
      assert.ok(ata, "the route opens a token account, so there is a setup instruction");
      // The stub hands back its own payer in that slot (real Jupiter: the user); what matters is that the
      // sponsor was NOT written over it.
      assert.notStrictEqual(m.staticAccounts[ata!.accountIndices![0]], SPONSOR, "an external wallet pays its own rent");
      assert.strictEqual(m.staticAccounts[0], SPONSOR, "the fee payer is still the sponsor");
    }
    assert.strictEqual(await prisma.sponsorFundedAccount.count({ where: { attemptId: ext.attemptId } }), 0, "nothing recorded as sponsor-funded");
    await prisma.stockBuyAttempt.update({ where: { id: ext.attemptId }, data: { status: "EXPIRED" } });
    await prisma.stockBuyAttempt.update({ where: { id: spon.attemptId }, data: { status: "PENDING" } });
    walletClient = "privy";

    // ── 12. A tx whose MESSAGE differs is never co-signed. Same attempt, a tx built one blockhash
    //       later: it decodes, it is signed, and it is still refused — nothing is sent.
    blockhashSeed = 9;
    await prisma.stockBuyAttempt.update({ where: { id: spon.attemptId }, data: { status: "EXPIRED" } });
    res = await post(txRoute, "/api/stocks/real/tx", { assetId, stakeCents: 100, payer: PAYER });
    assert.strictEqual(res.status, 200);
    const other = (await res.json()) as { attemptId: string; swapTransaction: string };
    assert.notStrictEqual(other.swapTransaction, spon.swapTransaction, "a different blockhash -> a different tx");
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: other.attemptId } })).unsignedTx,
      other.swapTransaction,
      "a sponsored BUY stores its built bytes — the guard-tolerant submit compares against them",
    );
    await prisma.stockBuyAttempt.update({ where: { id: spon.attemptId }, data: { status: "PENDING" } });
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
    await prisma.stockBuyAttempt.update({ where: { id: other.attemptId }, data: { status: "EXPIRED" } });

    // 12b. Phantom's rewrite: OUR message with one more static account and one more instruction (a
    //      Lighthouse guard) — every table-loaded index shifts by one — user-signed: co-signed. The
    //      same rewrite with any other program: refused. (coSign directly: this attempt is not sent.)
    const { coSign, LIGHTHOUSE_PROGRAM } = await import("../src/lib/sponsor");
    const withExtra = (b64: string, program: string): string => {
      const codec = getCompiledTransactionMessageCodec();
      const m = codec.decode(getTransactionDecoder().decode(bytes(b64)).messageBytes);
      const n = m.staticAccounts.length;
      const shift = (i: number) => (i >= n ? i + 1 : i);
      const rewritten = {
        ...m,
        header: { ...m.header, numReadonlyNonSignerAccounts: m.header.numReadonlyNonSignerAccounts + 1 },
        staticAccounts: [...m.staticAccounts, address(program)],
        instructions: [
          ...m.instructions.map((ix) => ({ ...ix, programAddressIndex: shift(ix.programAddressIndex), accountIndices: ix.accountIndices?.map(shift) })),
          { programAddressIndex: n, accountIndices: [1], data: new Uint8Array([7, 0, 0]) },
        ],
      };
      const messageBytes = codec.encode(rewritten);
      const signatures: Record<string, null> = {};
      for (const a of rewritten.staticAccounts.slice(0, m.header.numSignerAccounts)) signatures[a] = null;
      return Buffer.from(getTransactionEncoder().encode({ messageBytes, signatures } as never)).toString("base64");
    };
    const otherHash = (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: other.attemptId } })).msgHash;
    const co = await coSign({
      signedTransactionB64: await signAsUser(withExtra(other.swapTransaction, LIGHTHOUSE_PROGRAM)),
      expectedMessageHash: otherHash,
      userAddress: PAYER,
      builtTransactionB64: other.swapTransaction,
    });
    assert.ok(co.sig.length >= 64, "our message + a Lighthouse guard is co-signed");
    await assert.rejects(
      coSign({
        signedTransactionB64: await signAsUser(withExtra(other.swapTransaction, "11111111111111111111111111111111")),
        expectedMessageHash: otherHash,
        userAddress: PAYER,
        builtTransactionB64: other.swapTransaction,
      }),
      /tx_mismatch/,
      "our message + anything else is refused",
    );
    // ── 13. The real thing: the user signs, we co-sign and send, the attempt carries the signature.
    //       The signature is the FEE PAYER's own — computed from the co-signed bytes before the send,
    //       and checked against the RPC response, so a send that never answers still leaves a row we
    //       can follow.
    sent = [];
    res = await post(submitRoute, "/api/stocks/real/submit", {
      attemptId: spon.attemptId,
      signedTransaction: await signAsUser(spon.swapTransaction),
    });
    assert.strictEqual(res.status, 200);
    const submittedSig = ((await res.json()) as { sig: string }).sig;
    assert.strictEqual(sent.length, 1, "exactly one send");
    const sentSlots = getTransactionDecoder().decode(bytes(sent[0])).signatures as Record<string, Uint8Array | null>;
    assert.strictEqual(sentSlots[PAYER]?.length, 64, "the user signature is on the wire");
    assert.strictEqual(sentSlots[SPONSOR]?.length, 64, "and so is the sponsor one");
    assert.strictEqual(submittedSig, getBase58Decoder().decode(sentSlots[SPONSOR]!), "the returned sig IS the sent tx's signature");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: spon.attemptId } })).sig, submittedSig);

    // A confirmed attempt is idempotent: it returns its durable signature without another send.
    await prisma.stockBuyAttempt.update({ where: { id: spon.attemptId }, data: { status: "CONFIRMED" } });
    res = await post(submitRoute, "/api/stocks/real/submit", {
      attemptId: spon.attemptId,
      signedTransaction: await signAsUser(spon.swapTransaction),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(((await res.json()) as { sig: string }).sig, submittedSig);
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

    // Holding MORE than the lot: the account stays open (something else lives in it). The attempt
    // above is retired first — a sell already in flight is RE-SERVED, not rebuilt (case 26).
    await prisma.stockBuyAttempt.updateMany({ where: { id: sellJson.attemptId }, data: { status: "EXPIRED" } });
    walletRaw = 299_330n * 2n;
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lot1.id });
    assert.strictEqual(res.status, 200);
    const sellPartial = (await res.json()) as { attemptId: string; swapTransaction: string };
    assert.strictEqual(hasCloseAccountIx(sellPartial.swapTransaction), false, "a wallet holding more keeps its account");

    // ── 15. Confirm the sell from a landed tx whose PAYER IS A SIGNER BUT NOT KEY 0 (the sponsor
    //       pays): the lot closes with the proceeds the chain actually paid.
    // /real/submit co-signs, stamps, and sends the exact wire that the receipt later returns.
    const sellPartialSigned = await signAsUser(sellPartial.swapTransaction);
    const sellPartialSig = await submitSigned(userId!, sellPartial.attemptId, sellPartialSigned);
    landWire(sentWire(sellPartialSig), makeSellTx(299_330n, 1_010_000n));
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellPartial.attemptId, sig: sellPartialSig });
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
    assert.strictEqual(closedLot1.sellTxSig, sellPartialSig);
    assert.strictEqual(closedLot1.proceedsCents, 101);
    assert.strictEqual(closedLot1.pnlCents, 1);
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellPartial.attemptId } })).status, "CONFIRMED");
    const vb2 = await prisma.virtualBalance.findUnique({ where: { userId } });
    assert.strictEqual(vb2?.lockedCents ?? 0, 0, "a REAL sell touches no paper balance");

    // Replay -> the same answer, no second close.
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellPartial.attemptId, sig: sellPartialSig });
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

    // ── 17. Sponsored BUY and SELL quotas are independent rolling 24 h buckets.
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
        sig: `cap-sig-${RUN}-${i}`, // SENT attempts are what the cap counts
        status: "CONFIRMED" as const, // and resolved, so buy_in_flight stays out of the way
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
    assert.strictEqual(res.status, 200, "a full BUY bucket does not consume the SELL bucket");
    const quotaSell = (await res.json()) as { attemptId: string };
    await prisma.stockBuyAttempt.update({ where: { id: quotaSell.attemptId }, data: { status: "EXPIRED" } });

    // With the key removed the self-paid build works again — an unsponsored attempt is not capped.
    delete process.env.STOCK_SPONSOR_SECRET;
    const selfPaid = await buildAttempt(
      { id: userId!, stockConsentVersion: STOCK_TERMS_VERSION },
      { assetId: assetId!, stakeCents: 100, payer: PAYER },
    );
    assert.strictEqual(selfPaid.feePayer, null, "no key -> the wallet pays its own fee");
    assert.strictEqual(signatureOf(await signAsUser(selfPaid.swapTransaction)).length > 0, true, "...via a real plain /swap wire");

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

    // ── 19. The sponsor cap is ONE decision. At cap-1 two builds race: exactly one creates an
    //       attempt, because the count and the insert share a per-user lock.
    process.env.STOCK_SPONSOR_SECRET = SPONSOR_B58;
    await prisma.stockBuyAttempt.deleteMany({ where: { userId, msgHash: { startsWith: "cap-" } } });
    usdcRaw = 100_000_000n; // case 18 shrank the wallet — every stake must fit again
    walletRaw = 0n; // and the wallet holds none of the mint: opening its account is on the sponsor
    height = 900;
    const me2 = { id: userId!, stockConsentVersion: STOCK_TERMS_VERSION };
    const buy = () => buildAttempt(me2, { assetId: assetId!, stakeCents: 100, payer: PAYER });
    // The serialisation itself, deterministically: hold this user's advisory lock in a parallel
    // transaction and the build cannot get past its own count until the holder commits. (The race
    // below is the outcome; this is the mechanism that makes the outcome reliable.)
    let lockReleased = false;
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      await new Promise((r) => setTimeout(r, 300));
      lockReleased = true;
    });
    const blocked = buy().then((r) => {
      assert.ok(lockReleased, "a sponsored build waits for the user's own lock before it counts");
      return r;
    });
    const [, blockedAttempt] = await Promise.all([holder, blocked]);
    await prisma.stockBuyAttempt.update({ where: { id: blockedAttempt.attemptId }, data: { status: "EXPIRED" } });

    // Stage the wallet at EXACTLY cap-1, counting the sponsored attempts the cases above already made.
    // SENT or still LIVE attempts count toward the cap — an expired, never-signed build is free.
    const usedSoFar = await prisma.stockBuyAttempt.count({
      where: {
        userId,
        sponsored: true,
        kind: "BUY",
        createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
        OR: [{ sig: { not: null } }, { status: "PENDING" }],
      },
    });
    const toSeed = STOCK_SPONSOR_MAX_PER_USER_PER_DAY - 1 - usedSoFar;
    assert.ok(toSeed >= 0, `the daily cap has room to stage the race (used ${usedSoFar})`);
    await prisma.stockBuyAttempt.createMany({
      data: Array.from({ length: toSeed }, (_, i) => ({
        userId: userId!,
        assetId: assetId!,
        payer: PAYER,
        sponsored: true,
        stakeCents: 100,
        inAmountMicro: 1_000_000n,
        minOutBase: 297_834n,
        msgHash: `race-${i}`,
        sig: `race-sig-${RUN}-${i}`, // sent, so it counts
        status: "CONFIRMED" as const,
        lastValidBlockHeight: 1000n,
      })),
    });
    // And an EXPIRED never-signed one does not: stage one, still exactly one slot left.
    await prisma.stockBuyAttempt.create({
      data: { userId: userId!, assetId: assetId!, payer: PAYER, sponsored: true, stakeCents: 100, inAmountMicro: 1_000_000n, minOutBase: 297_834n, msgHash: `race-unsigned-${RUN}`, lastValidBlockHeight: 1000n, status: "EXPIRED" },
    });
    const raced = await Promise.allSettled([buy(), buy()]);
    const won = raced.filter((r) => r.status === "fulfilled");
    assert.strictEqual(won.length, 2, "both concurrent callers receive a safe response");
    const wonId = (won[0] as PromiseFulfilledResult<{ attemptId: string }>).value.attemptId;
    assert.strictEqual(
      (won[1] as PromiseFulfilledResult<{ attemptId: string }>).value.attemptId,
      wonId,
      "two concurrent BUY builds reserve one attempt and one signable transaction",
    );
    const wonRow = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: wonId } });
    assert.strictEqual(wonRow.rentFromSponsor, true, "a sponsored first buy fronts the token-account rent");
    assert.strictEqual(
      (await prisma.sponsorFundedAccount.findUniqueOrThrow({ where: { account: TOKEN_ACCOUNT } })).attemptId,
      wonId,
      "the reserved attempt is never observable before its sponsor-rent provenance commits",
    );
    await prisma.sponsorFundedAccount.deleteMany({ where: { attemptId: wonId } });
    await prisma.stockBuyAttempt.update({ where: { id: wonId }, data: { status: "EXPIRED" } });
    await prisma.stockBuyAttempt.deleteMany({ where: { userId, msgHash: { startsWith: "race-" } } });

    // ── 20. A send that fails AFTER the signature is decided. The attempt keeps the signature (the
    //       swap may well have landed), a second buy of the same asset is refused meanwhile, and the
    //       sweep settles it.
    blockhashSeed = 10;
    walletRaw = 299_330n; // this time the wallet already holds the mint
    const flight = await buy();
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: flight.attemptId } })).rentFromSponsor,
      false,
      "a wallet that already holds the mint pays no new rent",
    );
    sendFails = true;
    sent = [];
    const flightSigned = await signAsUser(flight.swapTransaction);
    await assert.rejects(
      () => submitSigned(userId!, flight.attemptId, flightSigned),
      (e: Error) => e.name === "HeliusUnavailableError",
    );
    sendFails = false;
    const stamped = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: flight.attemptId } });
    assert.strictEqual(stamped.status, "PENDING");
    assert.ok(stamped.sig, "the signature is stamped BEFORE the send, so a lost send is still recoverable");
    const retriedFlight = await buy();
    assert.strictEqual(retriedFlight.attemptId, flight.attemptId, "a retry re-serves the stamped BUY attempt");
    assert.strictEqual(retriedFlight.swapTransaction, flight.swapTransaction, "the retry uses the exact original wire");
    assert.ok(stamped.signedTx, "the exact signed wire is durable before broadcast");
    landWire(stamped.signedTx!, makeTx(1_000_000n, 299_330n)); // it did land after all
    await prisma.stockBuyAttempt.update({
      where: { id: flight.attemptId },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    await sweepAttempts();
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: flight.attemptId } })).status,
      "CONFIRMED",
      "the sweep confirms the stamped attempt",
    );

    // ── 21. A sponsored attempt is bound to the signature the SERVER stamped: another receipt,
    //       however valid, belongs to another transaction.
    blockhashSeed = 11; // a different message, or this build would be byte-identical to case 20's —
    // same bytes, same signature, and the signature is the identity of the transaction.
    const bound = await buy();
    const boundSig = await submitSigned(userId!, bound.attemptId, await signAsUser(bound.swapTransaction));
    const foreignSigned = await signAsUser(unsignedSelfPaidWire());
    const foreignSig = landWire(foreignSigned, makeTx(1_000_000n, 299_330n)); // a good swap, but another wire
    await assert.rejects(
      () => confirmAttempt(userId!, bound.attemptId, foreignSig, { polls: 1, sleepMs: 0 }),
      (e: Error) => e.message === "not_this_buy",
    );
    const untouched = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: bound.attemptId } });
    assert.strictEqual(untouched.status, "PENDING", "a foreign receipt changes nothing");
    assert.strictEqual(untouched.sig, boundSig, "...not even the stamped signature");
    landWire(sentWire(boundSig), makeTx(1_000_000n, 299_330n));
    assert.strictEqual(
      (await confirmAttempt(userId!, bound.attemptId, boundSig, { polls: 1, sleepMs: 0 })).alreadyConfirmed,
      false,
      "its own receipt books the lot",
    );

    // ── 22. Self-paid: a FAILED transaction our payer never signed must not fail our attempt, and a
    //       swap that spent LESS than we quoted is an older buy, not this one.
    delete process.env.STOCK_SPONSOR_SECRET;
    const selfAttempt = await buy();
    const selfSigned = await signAsUser(selfAttempt.swapTransaction);
    const selfSig = landWire(selfSigned, {
      meta: { err: { InstructionError: [0, "Custom"] }, preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: SPONSOR, signer: true }] } },
    });
    await assert.rejects(
      () => confirmAttempt(userId!, selfAttempt.attemptId, selfSig, { polls: 1, sleepMs: 0 }),
      (e: Error) => e.message === "not_this_buy",
    );
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: selfAttempt.attemptId } })).status,
      "PENDING",
      "someone else's failed tx never marks our attempt FAILED",
    );
    replaceParsed(selfSig, makeTx(999_999n, 299_330n));
    await assert.rejects(
      () => confirmAttempt(userId!, selfAttempt.attemptId, selfSig, { polls: 1, sleepMs: 0 }),
      (e: Error) => e.message === "not_this_buy",
    );
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: selfAttempt.attemptId } })).status,
      "PENDING",
      "a smaller swap is a different swap",
    );

    // ── 23. A hedge suggestion already accepted (on PAPER) blocks a REAL buy for it — and a swap
    //       that landed anyway is still booked, minus the back-reference.
    const sid = `sug-${RUN}`;
    await prisma.stockPosition.create({
      data: {
        userId,
        assetId: assetId!,
        mode: "PAPER",
        source: "HEDGE",
        hedgeSuggestionId: sid,
        qtyBase: 1n,
        costCents: 100,
        entryPriceCents: 100,
      },
    });
    await assert.rejects(
      () => buildAttempt(me2, { assetId: assetId!, stakeCents: 100, payer: PAYER, hedgeSuggestionId: sid }),
      (e: Error) => e.message === "hedge_already_accepted",
    );
    const hedgedUnsigned = unsignedSelfPaidWire();
    const hedgedSigned = await signAsUser(hedgedUnsigned);
    const hedged = await prisma.stockBuyAttempt.create({
      data: {
        userId,
        assetId: assetId!,
        payer: PAYER,
        stakeCents: 100,
        inAmountMicro: 1_000_000n,
        minOutBase: 297_834n,
        msgHash: messageHash(hedgedUnsigned),
        unsignedTx: hedgedUnsigned,
        lastValidBlockHeight: 1000n,
        hedgeSuggestionId: sid,
      },
    });
    const hedgedSig = landWire(hedgedSigned, makeTx(1_000_000n, 299_330n));
    const hedgedLot = await confirmAttempt(userId!, hedged.id, hedgedSig, { polls: 1, sleepMs: 0 });
    const hedgedRow = await prisma.stockPosition.findUniqueOrThrow({ where: { id: hedgedLot.positionId } });
    assert.strictEqual(hedgedRow.mode, "REAL");
    assert.strictEqual(hedgedRow.hedgeSuggestionId, null, "a landed swap is booked even when the suggestion is taken");

    // ── 24. Reconcile while a sell is in flight: lots A (older) and B (newer) of one mint, A's
    //       tokens already off the chain. Closing newest-first off that snapshot would close B — the
    //       lot the wallet still backs — so the mint is skipped entirely until the sale resolves.
    await prisma.stockPosition.updateMany({
      where: { userId, mode: "REAL", closedAt: null },
      data: { closedAt: new Date(), closeReason: "reset" },
    });
    const mkLot = (txSig: string, ageMs: number, rentFromSponsor = false) =>
      prisma.stockPosition.create({
        data: {
          userId: userId!,
          assetId: assetId!,
          mode: "REAL",
          source: "DECK",
          qtyBase: 299_330n,
          costCents: 100,
          entryPriceCents: 33_408,
          txSig,
          payer: PAYER,
          rentFromSponsor,
          createdAt: new Date(Date.now() - ageMs),
        },
      });
    const lotA = await mkLot(SIG14, 120_000);
    const lotB = await mkLot(SIG15, 60_000, true);
    const sellAUnsigned = unsignedSelfPaidWire();
    const sellASigned = await signAsUser(sellAUnsigned);
    const sellASig = signatureOf(sellASigned);
    const sellA = await prisma.stockBuyAttempt.create({
      data: {
        userId,
        assetId: assetId!,
        payer: PAYER,
        kind: "SELL",
        positionId: lotA.id,
        sponsored: true,
        stakeCents: 100,
        inAmountMicro: 299_330n,
        minOutBase: 1_000_000n,
        msgHash: messageHash(sellAUnsigned),
        unsignedTx: sellAUnsigned,
        signedTx: sellASigned,
        signedTxHash: createHash("sha256").update(Buffer.from(sellASigned, "base64")).digest("hex"),
        sig: sellASig,
        lastValidBlockHeight: 1000n,
      },
    });
    walletRaw = 299_330n; // A's tokens are gone; only B's remain
    assert.strictEqual((await reconcileRealLots(userId!, PAYER)).closed, 0, "a mint with a sell in flight is left alone");
    assert.strictEqual(
      (await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotB.id } })).closedAt,
      null,
      "the newer lot is not closed behind the sale's back",
    );
    assert.strictEqual(
      (await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotA.id } })).walletCheckedAt,
      null,
      "...and nothing of that mint is stamped either",
    );
    landWire(sellASigned, makeSellTx(299_330n, 1_010_000n));
    const soldA = await confirmAttempt(userId!, sellA.id, sellASig, { polls: 1, sleepMs: 0 });
    assert.strictEqual(soldA.positionId, lotA.id, "the sell closes the lot it was built for");
    assert.strictEqual(
      (await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotB.id } })).closedAt,
      null,
      "and the lot the wallet still backs stays open",
    );

    // ── 25. The reclaimed token-account rent goes back to whoever fronted THE ACCOUNT (case 33 is
    //       the same question end to end, from the buy that opened it).
    process.env.STOCK_SPONSOR_SECRET = SPONSOR_B58;
    await prisma.sponsorFundedAccount.upsert({
      where: { account: TOKEN_ACCOUNT },
      create: { account: TOKEN_ACCOUNT, userId, payer: PAYER, mint: MINT, confirmedAt: new Date() },
      update: { userId, payer: PAYER, mint: MINT, confirmedAt: new Date(), closedAt: null },
    });
    const sellB = await buildSellAttempt(me2, lotB.id);
    assert.ok(hasCloseAccountIx(sellB.swapTransaction), "the whole balance is sold -> the account is closed");
    assert.strictEqual(closeDestination(sellB.swapTransaction), SPONSOR, "the sponsor opened it -> the rent returns to the sponsor");
    // The same lot, with an account the wallet funded itself. (Retire the attempt above first: a
    // sell in flight is RE-SERVED, which is case 26.)
    await prisma.stockBuyAttempt.updateMany({ where: { id: sellB.attemptId }, data: { status: "EXPIRED" } });
    await prisma.sponsorFundedAccount.deleteMany({ where: { account: TOKEN_ACCOUNT } });
    const sellB2 = await buildSellAttempt(me2, lotB.id);
    assert.strictEqual(closeDestination(sellB2.swapTransaction), PAYER, "a wallet that funded its own account keeps the rent");

    // ── 26. A retried sell RE-SERVES the attempt in flight (same bytes = same signature on chain),
    //       and a second attempt for a lot that is already sold is refused before a byte is sent.
    const retry = await buildSellAttempt(me2, lotB.id);
    assert.strictEqual(retry.attemptId, sellB2.attemptId, "the retry is the same attempt");
    assert.strictEqual(retry.swapTransaction, sellB2.swapTransaction, "...with the very same transaction");
    const rowB2 = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellB2.attemptId } });
    const stale = await prisma.stockBuyAttempt.create({
      data: {
        userId,
        assetId: assetId!,
        payer: PAYER,
        kind: "SELL",
        positionId: lotB.id,
        sponsored: true,
        stakeCents: 100,
        inAmountMicro: rowB2.inAmountMicro,
        minOutBase: rowB2.minOutBase,
        msgHash: rowB2.msgHash, // built before the fix: a SECOND live sell of one lot
        unsignedTx: rowB2.unsignedTx,
        lastValidBlockHeight: rowB2.lastValidBlockHeight,
      },
    });
    const sellB2Sig = await submitSigned(userId!, sellB2.attemptId, await signAsUser(sellB2.swapTransaction));
    landWire(sentWire(sellB2Sig), makeSellTx(299_330n, 1_010_000n));
    await confirmAttempt(userId!, sellB2.attemptId, sellB2Sig, { polls: 1, sleepMs: 0 });
    sent = [];
    const staleSigned = await signAsUser(sellB2.swapTransaction);
    await assert.rejects(() => submitSigned(userId!, stale.id, staleSigned), (e: Error) => e.message === "lot_closed");
    assert.strictEqual(sent.length, 0, "a sell whose lot another sale already closed is never sent");

    // ── 27. A candidate receipt that ANOTHER attempt already booked must not wedge the sweep: the
    //       attempt expires instead of staying PENDING for ever and holding a slot in every sweep.
    height = 2000;
    const orphanFixture = await mkOld();
    const orphan = orphanFixture.attempt;
    SIGS = [{ signature: old2.sig, blockTime: Math.floor(Date.now() / 1000), err: null }]; // old2's lot is already booked
    await sweepAttempts();
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: orphan.id } })).status,
      "EXPIRED",
      "an unbookable receipt expires the attempt instead of throwing out of the loop",
    );

    // ── 28. The sweep's snapshot is minutes old by the time it writes: a confirm that won the race
    //       in between is never overwritten with EXPIRED.
    await prisma.stockBuyAttempt.deleteMany({ where: { userId, status: "PENDING" } });
    const expiredBefore = await prisma.stockBuyAttempt.count({ where: { userId, status: "EXPIRED" } });
    const racer = (await mkOld()).attempt;
    SIGS = [];
    onSigs = async () => {
      onSigs = null;
      await prisma.stockBuyAttempt.update({ where: { id: racer.id }, data: { status: "CONFIRMED", resolvedAt: new Date() } });
    };
    await sweepAttempts();
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: racer.id } })).status,
      "CONFIRMED",
      "a CONFIRMED attempt survives a stale sweep",
    );
    assert.strictEqual(
      await prisma.stockBuyAttempt.count({ where: { userId, status: "EXPIRED" } }),
      expiredBefore,
      "...and no expiry of ours was counted",
    );


    // ── 29. The cases above spent sponsored attempts against the rolling daily cap; age them out, or
    //       the ones below would be refused for the wrong reason.
    await prisma.stockBuyAttempt.updateMany({ where: { userId }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    process.env.STOCK_SPONSOR_SECRET = SPONSOR_B58;
    height = 900;
    walletRaw = 299_330n;
    usdcRaw = 100_000_000n;

    //     /real/sent is the SELF-PAID channel. A sponsored attempt's signature is the server's own:
    //     accepting a client-sent one would bind an arbitrary landed transaction to an attempt we
    //     never sent — and the sweep, which trusts a stamped signature, would confirm it.
    blockhashSeed = 21;
    const sponSent = await buy();
    res = await post(sentRoute, "/api/stocks/real/sent", { attemptId: sponSent.attemptId, sig: SIG18 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "not_self_paid");
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sponSent.attemptId } })).sig,
      null,
      "...and nothing is stamped",
    );

    // ── 30. A sponsored SELL is bound to the signature the server sent, BEFORE the kind dispatch:
    //       another receipt — a perfectly good sale of the same size — confirms nothing, fails
    //       nothing, and leaves the stamped signature alone.
    const lotC = await mkLot(SIG19, 30_000);
    const sellC = await buildSellAttempt(me2, lotC.id);
    const sellCSig = await submitSigned(userId!, sellC.attemptId, await signAsUser(sellC.swapTransaction));
    const otherSaleWire = await signAsUser(unsignedSelfPaidWire());
    const otherSaleSig = landWire(otherSaleWire, makeSellTx(299_330n, 1_010_000n));
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellC.attemptId, sig: otherSaleSig });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "not_this_buy");
    const foreign = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellC.attemptId } });
    assert.strictEqual(foreign.status, "PENDING", "a foreign receipt changes nothing");
    assert.strictEqual(foreign.sig, sellCSig, "...not even the stamped signature");
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotC.id } })).closedAt, null);

    // ── 31. That sale then LANDS while the client is away. The next build must not expire it on
    //       block height and quote a second sale of tokens that are already gone: it resolves the
    //       stamped attempt against the chain first, books the lot, and says the lot is closed.
    landWire(sentWire(sellCSig), makeSellTx(299_330n, 1_010_000n));
    height = 2000; // past the attempt's blockhash — where the old code expired it and rebuilt
    res = await post(sellRoute, "/api/stocks/real/sell-tx", { positionId: lotC.id });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "lot_closed");
    const soldC = await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotC.id } });
    assert.strictEqual(soldC.closeReason, "sold");
    assert.strictEqual(soldC.sellTxSig, sellCSig);
    assert.strictEqual(soldC.proceedsCents, 101, "the sale the user really made is what the lot books");
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellC.attemptId } })).status,
      "CONFIRMED",
    );

    // ── 32. ONE live sell per lot, decided under this user's own lock: two builds racing for the
    //       same lot reserve ONE attempt. (Two live sells would both leave the wallet, and only the
    //       first could ever be booked against the lot.)
    height = 900;
    const lotD = await mkLot(SIG21, 30_000);
    const [d1, d2] = await Promise.all([buildSellAttempt(me2, lotD.id), buildSellAttempt(me2, lotD.id)]);
    assert.strictEqual(d1.attemptId, d2.attemptId, "two concurrent builds, one attempt");
    assert.strictEqual(
      await prisma.stockBuyAttempt.count({ where: { positionId: lotD.id, kind: "SELL", status: "PENDING" } }),
      1,
      "...and exactly one live sell on the row",
    );
    const d3 = await buildSellAttempt(me2, lotD.id);
    assert.strictEqual(d3.attemptId, d1.attemptId, "a later retry re-serves it too");
    assert.strictEqual(d3.swapTransaction, d1.swapTransaction, "...with the very same bytes");

    // A stamped sell with no receipt remains ambiguous even after its blockheight. The sweep keeps
    // it PENDING and a later build re-serves the exact same attempt and wire.
    blockhashSeed = 22;
    const lotE = await mkLot(SIG22, 30_000);
    const missingReceipt = await buildSellAttempt(me2, lotE.id);
    const missingReceiptSig = await submitSigned(userId!, missingReceipt.attemptId, await signAsUser(missingReceipt.swapTransaction));
    assert.strictEqual(RAW_TXS[missingReceiptSig] ?? null, null, "the RPC has no landed receipt");
    await prisma.stockBuyAttempt.update({
      where: { id: missingReceipt.attemptId },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    height = 2000;
    await sweepAttempts();
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: missingReceipt.attemptId } })).status,
      "PENDING",
      "an ambiguous stamped sale is never freed by blockheight alone",
    );
    const reservedMissing = await buildSellAttempt(me2, lotE.id);
    assert.strictEqual(reservedMissing.attemptId, missingReceipt.attemptId);
    assert.strictEqual(reservedMissing.swapTransaction, missingReceipt.swapTransaction);

    // A pre-audit pending sell has no bytes that can be proved or safely re-served. It remains
    // quarantined for manual review and blocks any second sale of the same lot.
    height = 900;
    const lotF = await mkLot(`${SIG22}-legacy`, 20_000);
    const legacy = await prisma.stockBuyAttempt.create({
      data: {
        userId,
        assetId: assetId!,
        payer: PAYER,
        kind: "SELL",
        positionId: lotF.id,
        sponsored: true,
        stakeCents: 100,
        inAmountMicro: 299_330n,
        minOutBase: 1_000_000n,
        msgHash: `legacy-${RUN}`,
        lastValidBlockHeight: 1000n,
      },
    });
    await assert.rejects(() => buildSellAttempt(me2, lotF.id), (e: Error) => e.message === "sell_manual_review");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: legacy.id } })).status, "PENDING");
    assert.strictEqual(
      await prisma.stockBuyAttempt.count({ where: { positionId: lotF.id, kind: "SELL", status: "PENDING" } }),
      1,
      "legacy quarantine never creates a second sell attempt",
    );

    // ── 33. Rent provenance is per ACCOUNT, end to end. The buy that OPENS the token account fronts
    //       its rent; a later buy into the same account fronts nothing — and the sell that finally
    //       closes it still owes the refund to the sponsor, whichever lot it happens to be.
    await prisma.sponsorFundedAccount.deleteMany({ where: { userId } });
    await prisma.stockPosition.updateMany({
      where: { userId, mode: "REAL", closedAt: null },
      data: { closedAt: new Date(), closeReason: "reset" },
    });
    await prisma.stockBuyAttempt.updateMany({ where: { userId, status: "PENDING" }, data: { status: "EXPIRED" } });
    walletRaw = 0n; // the wallet holds none of the mint: the sponsor opens its account
    blockhashSeed = 23;
    const openBuy = await buy();
    const fundedRow = await prisma.sponsorFundedAccount.findUniqueOrThrow({ where: { account: TOKEN_ACCOUNT } });
    assert.strictEqual(fundedRow.attemptId, openBuy.attemptId);
    assert.strictEqual(fundedRow.mint, MINT);
    assert.strictEqual(fundedRow.confirmedAt, null, "nothing is spent until the swap lands");
    const openSig = await submitSigned(userId!, openBuy.attemptId, await signAsUser(openBuy.swapTransaction));
    landWire(sentWire(openSig), makeTx(1_000_000n, 299_330n));
    const openLot = await confirmAttempt(userId!, openBuy.attemptId, openSig, { polls: 1, sleepMs: 0 });
    assert.ok(
      (await prisma.sponsorFundedAccount.findUniqueOrThrow({ where: { account: TOKEN_ACCOUNT } })).confirmedAt,
      "the landed buy confirms the rent really was spent",
    );

    walletRaw = 299_330n; // the account exists now
    blockhashSeed = 24;
    const sameAccount = await buy();
    assert.strictEqual(
      await prisma.sponsorFundedAccount.count({ where: { userId } }),
      1,
      "a buy into an account that already exists funds nothing new",
    );
    const sameSig = await submitSigned(userId!, sameAccount.attemptId, await signAsUser(sameAccount.swapTransaction));
    landWire(sentWire(sameSig), makeTx(1_000_000n, 299_330n));
    const secondLot = await confirmAttempt(userId!, sameAccount.attemptId, sameSig, { polls: 1, sleepMs: 0 });
    assert.strictEqual(
      (await prisma.stockPosition.findUniqueOrThrow({ where: { id: secondLot.positionId } })).rentFromSponsor,
      false,
      "this lot fronted no rent...",
    );

    // The first lot leaves the wallet elsewhere; the SECOND is the last one and closes the account.
    await prisma.stockPosition.update({
      where: { id: openLot.positionId },
      data: { closedAt: new Date(), closeReason: "reset" },
    });
    const lastSell = await buildSellAttempt(me2, secondLot.positionId);
    assert.ok(hasCloseAccountIx(lastSell.swapTransaction));
    assert.strictEqual(
      closeDestination(lastSell.swapTransaction),
      SPONSOR,
      "...but the SPONSOR opened the account, so the rent goes back to the sponsor",
    );
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: lastSell.attemptId } })).closeAta, true);
    const lastSig = await submitSigned(userId!, lastSell.attemptId, await signAsUser(lastSell.swapTransaction));
    landWire(sentWire(lastSig), makeSellTx(299_330n, 1_010_000n));
    await confirmAttempt(userId!, lastSell.attemptId, lastSig, { polls: 1, sleepMs: 0 });
    assert.ok(
      (await prisma.sponsorFundedAccount.findUniqueOrThrow({ where: { account: TOKEN_ACCOUNT } })).closedAt,
      "the account is closed and its funding row retires with it",
    );

    // ── 34. Reconcile decides under the same lock a sell confirm takes. A lot closed between the
    //       balance read and the decision makes that snapshot a lie: closing "the rest" off it would
    //       close a lot the wallet still backs.
    await prisma.stockPosition.updateMany({
      where: { userId, mode: "REAL", closedAt: null },
      data: { closedAt: new Date(), closeReason: "reset" },
    });
    await prisma.stockBuyAttempt.updateMany({ where: { userId, status: "PENDING" }, data: { status: "EXPIRED" } });
    const lotG = await mkLot(SIG23, 120_000); // older
    const lotH = await mkLot(SIG24, 60_000); // newer
    walletRaw = 299_330n; // the wallet backs exactly ONE of the two
    onTokenAccounts = async () => {
      onTokenAccounts = null;
      // Exactly what a sell confirm landing in this instant does to lot G.
      await prisma.stockPosition.update({
        where: { id: lotG.id },
        data: { closedAt: new Date(), closeReason: "sold", proceedsCents: 101, pnlCents: 1 },
      });
    };
    assert.strictEqual(
      (await reconcileRealLots(userId!, PAYER)).closed,
      0,
      "a set that moved under the balance read waits for the next pass",
    );
    assert.strictEqual(
      (await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotH.id } })).closedAt,
      null,
      "the lot the wallet still backs stays open",
    );
    // Stable now: one lot and one lot's worth of tokens -> nothing to close; none -> it closes.
    assert.strictEqual((await reconcileRealLots(userId!, PAYER)).closed, 0);
    walletRaw = 0n;
    assert.strictEqual((await reconcileRealLots(userId!, PAYER)).closed, 1);
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotH.id } })).closeReason, "wallet");

    // ── 35. A STAMPED attempt whose exact wire landed with unexpected balance deltas is quarantined
    //       for manual review. It is never falsely expired or marked failed.
    walletRaw = 0n;
    blockhashSeed = 25;
    height = 900;
    const stuck = await buy();
    const stuckSig = await submitSigned(userId!, stuck.attemptId, await signAsUser(stuck.swapTransaction));
    landWire(sentWire(stuckSig), makeTx(999_999n, 299_330n)); // landed, but the balance delta does not match
    assert.strictEqual(await prisma.sponsorFundedAccount.count({ where: { attemptId: stuck.attemptId } }), 1);
    await prisma.stockBuyAttempt.updateMany({
      where: { userId, status: "PENDING", id: { not: stuck.attemptId } },
      data: { status: "EXPIRED" },
    });
    await prisma.stockBuyAttempt.update({
      where: { id: stuck.attemptId },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    const stuckSweep = await sweepAttempts();
    assert.ok(stuckSweep.scanned >= 1);
    const stuckRow = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: stuck.attemptId } });
    assert.strictEqual(stuckRow.status, "PENDING");
    assert.strictEqual(stuckRow.manualReviewReason, "not_this_buy", "the inconsistent landed receipt is quarantined");
    assert.strictEqual(
      await prisma.sponsorFundedAccount.count({ where: { attemptId: stuck.attemptId } }),
      1,
      "funding provenance remains until the ambiguous landed swap is reviewed",
    );

    // ── 36. The public health probe coalesces: five concurrent misses do ONE refresh, not five
    //       (four DB reads plus the sponsor balance each).
    const health = await import("../src/app/api/stocks/health/route");
    getBalanceCalls = 0;
    const probes = await Promise.all(Array.from({ length: 5 }, () => health.GET()));
    assert.strictEqual(getBalanceCalls, 1, "one sponsor balance read for five concurrent probes");
    const bodies = (await Promise.all(probes.map((r) => r.json()))) as unknown[];
    for (const b of bodies) assert.deepStrictEqual(b, bodies[0], "every probe gets the same answer");

    console.log("test-stocks-real-db: OK");
  } finally {
    if (userId) {
      const userIds = [userId];
      await prisma.stockPosition.deleteMany({ where: { userId } });
      await prisma.stockBuyAttempt.deleteMany({ where: { userId } });
      await prisma.sponsorFundedAccount.deleteMany({ where: { userId } });
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
