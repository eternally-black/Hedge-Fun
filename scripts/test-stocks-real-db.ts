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
// Addresses that must survive kit compilation — the MINT among them: it is the ATA setup
// instruction's mint account (compiled into the sponsored tx) as well as the asset's own mint, and
// the rent-provenance rows are keyed by it. Random per run, so parallel runs never collide.
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUP_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_ACCOUNT = "Ch4K4D2cTVNY7H7nJ2Y6byCiEeQzkE3AmGvJb1knYbTc";
const LUT = "2vtyH7Sawno2NXQr5JQYA6Qmhs14jLVo63qvnaKVZJdp";
const MINT = getBase58Decoder().decode(sk64().subarray(32));
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const SIG2 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUX";
const SIG3 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUY";
const SIG4 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUZ";
const SIG5 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUa";
const SIG6 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUb";
const SIG7 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUc";
const SIG8 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUd";
const SIG9 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUe";
const SIG10 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUf";
const SIG11 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUg";
const SIG12 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUh";
const SIG13 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUi";
const SIG14 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUj";
const SIG15 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUk";
const SIG16 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUm";
const SIG17 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUn";
const SIG18 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUo";
const SIG19 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUp";
const SIG20 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUq";
const SIG_LANDED = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUv";
const SIG_GHOST = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUw";
const SIG21 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUr";
const SIG22 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUs";
const SIG23 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUt";
const SIG24 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUu";

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
    //       The signature is the FEE PAYER's own — computed from the co-signed bytes before the send,
    //       not read back from the RPC (sendSig), so a send that never answers still leaves a row we
    //       can follow.
    sendSig = SIG6;
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
    TXS[SIG7] = makeSellTx(299_330n, 1_010_000n);
    // What /real/submit does before the send: the sponsored attempt carries the signature the SERVER
    // decided, and the confirm is bound to exactly that one (case 30).
    await prisma.stockBuyAttempt.update({ where: { id: sellPartial.attemptId }, data: { sig: SIG7 } });
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellPartial.attemptId, sig: SIG7 });
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
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellPartial.attemptId } })).status, "CONFIRMED");
    const vb2 = await prisma.virtualBalance.findUnique({ where: { userId } });
    assert.strictEqual(vb2?.lockedCents ?? 0, 0, "a REAL sell touches no paper balance");

    // Replay -> the same answer, no second close.
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellPartial.attemptId, sig: SIG7 });
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
    await Promise.all([holder, blocked]);

    // Stage the wallet at EXACTLY cap-1, counting the sponsored attempts the cases above already made.
    const usedSoFar = await prisma.stockBuyAttempt.count({
      where: { userId, sponsored: true, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
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
        lastValidBlockHeight: 1000n,
      })),
    });
    const raced = await Promise.allSettled([buy(), buy()]);
    const won = raced.filter((r) => r.status === "fulfilled");
    const lost = raced.filter((r) => r.status === "rejected");
    assert.strictEqual(won.length, 1, "exactly one of two concurrent builds at cap-1 gets the last sponsored slot");
    assert.strictEqual((lost[0] as PromiseRejectedResult).reason.name, "SponsorLimitError", "the other is refused");
    const wonId = (won[0] as PromiseFulfilledResult<{ attemptId: string }>).value.attemptId;
    const wonRow = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: wonId } });
    assert.strictEqual(wonRow.rentFromSponsor, true, "no token account for the mint -> the sponsor fronts its rent");
    await prisma.stockBuyAttempt.deleteMany({ where: { userId, msgHash: { startsWith: "race-" } } });

    // ── 20. A send that fails AFTER the signature is decided. The attempt keeps the signature (the
    //       swap may well have landed), a second buy of the same asset is refused meanwhile, and the
    //       sweep settles it.
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
    await assert.rejects(() => buy(), (e: Error) => e.message === "buy_in_flight");
    TXS[stamped.sig!] = makeTx(1_000_000n, 299_330n); // it did land after all
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
    TXS[SIG10] = makeTx(1_000_000n, 299_330n); // a perfectly good swap — just not this attempt's
    await assert.rejects(
      () => confirmAttempt(userId!, bound.attemptId, SIG10, { polls: 1, sleepMs: 0 }),
      (e: Error) => e.message === "not_this_buy",
    );
    const untouched = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: bound.attemptId } });
    assert.strictEqual(untouched.status, "PENDING", "a foreign receipt changes nothing");
    assert.strictEqual(untouched.sig, boundSig, "...not even the stamped signature");
    TXS[boundSig] = makeTx(1_000_000n, 299_330n);
    assert.strictEqual(
      (await confirmAttempt(userId!, bound.attemptId, boundSig, { polls: 1, sleepMs: 0 })).alreadyConfirmed,
      false,
      "its own receipt books the lot",
    );

    // ── 22. Self-paid: a FAILED transaction our payer never signed must not fail our attempt, and a
    //       swap that spent LESS than we quoted is an older buy, not this one.
    delete process.env.STOCK_SPONSOR_SECRET;
    const selfAttempt = await buy();
    TXS[SIG11] = {
      meta: { err: { InstructionError: [0, "Custom"] }, preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: SPONSOR, signer: true }] } },
    };
    await assert.rejects(
      () => confirmAttempt(userId!, selfAttempt.attemptId, SIG11, { polls: 1, sleepMs: 0 }),
      (e: Error) => e.message === "not_this_buy",
    );
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: selfAttempt.attemptId } })).status,
      "PENDING",
      "someone else's failed tx never marks our attempt FAILED",
    );
    TXS[SIG12] = makeTx(999_999n, 299_330n);
    await assert.rejects(
      () => confirmAttempt(userId!, selfAttempt.attemptId, SIG12, { polls: 1, sleepMs: 0 }),
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
    const hedged = await prisma.stockBuyAttempt.create({
      data: {
        userId,
        assetId: assetId!,
        payer: PAYER,
        stakeCents: 100,
        inAmountMicro: 1_000_000n,
        minOutBase: 297_834n,
        msgHash: `hedge-${RUN}`,
        lastValidBlockHeight: 1000n,
        hedgeSuggestionId: sid,
      },
    });
    TXS[SIG13] = makeTx(1_000_000n, 299_330n);
    const hedgedLot = await confirmAttempt(userId!, hedged.id, SIG13, { polls: 1, sleepMs: 0 });
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
        msgHash: `sellA-${RUN}`,
        sig: SIG16, // as /real/submit would have stamped it
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
    TXS[SIG16] = makeSellTx(299_330n, 1_010_000n);
    const soldA = await confirmAttempt(userId!, sellA.id, SIG16, { polls: 1, sleepMs: 0 });
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
    TXS[SIG17] = makeSellTx(299_330n, 1_010_000n);
    await prisma.stockBuyAttempt.update({ where: { id: sellB2.attemptId }, data: { sig: SIG17 } }); // as /real/submit does
    await confirmAttempt(userId!, sellB2.attemptId, SIG17, { polls: 1, sleepMs: 0 });
    sent = [];
    const staleSigned = await signAsUser(sellB2.swapTransaction);
    await assert.rejects(() => submitSigned(userId!, stale.id, staleSigned), (e: Error) => e.message === "lot_closed");
    assert.strictEqual(sent.length, 0, "a sell whose lot another sale already closed is never sent");

    // ── 27. A candidate receipt that ANOTHER attempt already booked must not wedge the sweep: the
    //       attempt expires instead of staying PENDING for ever and holding a slot in every sweep.
    height = 2000;
    const orphan = await mkOld("orphan");
    SIGS = [{ signature: SIG4, blockTime: Math.floor(Date.now() / 1000), err: null }]; // SIG4's lot is oldAttempt2's
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
    const racer = await mkOld("racer");
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
    TXS[SIG20] = makeSellTx(299_330n, 1_010_000n);
    res = await post(confirmRoute, "/api/stocks/real/confirm", { attemptId: sellC.attemptId, sig: SIG20 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await err(res), "not_this_buy");
    const foreign = await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: sellC.attemptId } });
    assert.strictEqual(foreign.status, "PENDING", "a foreign receipt changes nothing");
    assert.strictEqual(foreign.sig, sellCSig, "...not even the stamped signature");
    assert.strictEqual((await prisma.stockPosition.findUniqueOrThrow({ where: { id: lotC.id } })).closedAt, null);

    // ── 31. That sale then LANDS while the client is away. The next build must not expire it on
    //       block height and quote a second sale of tokens that are already gone: it resolves the
    //       stamped attempt against the chain first, books the lot, and says the lot is closed.
    TXS[sellCSig] = makeSellTx(299_330n, 1_010_000n);
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

    // A pending sell with no bytes to re-serve (a row from before they were stored) is retired
    // rather than left to block every future sale of that lot.
    const lotE = await mkLot(SIG22, 30_000);
    const legacy = await prisma.stockBuyAttempt.create({
      data: {
        userId,
        assetId: assetId!,
        payer: PAYER,
        kind: "SELL",
        positionId: lotE.id,
        sponsored: true,
        stakeCents: 100,
        inAmountMicro: 299_330n,
        minOutBase: 1_000_000n,
        msgHash: `legacy-${RUN}`,
        lastValidBlockHeight: 1000n,
      },
    });
    const afterLegacy = await buildSellAttempt(me2, lotE.id);
    assert.notStrictEqual(afterLegacy.attemptId, legacy.id, "a bytes-less pending sell cannot be re-served");
    assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: legacy.id } })).status, "EXPIRED");

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
    TXS[openSig] = makeTx(1_000_000n, 299_330n);
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
    TXS[sameSig] = makeTx(1_000_000n, 299_330n);
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
    TXS[lastSig] = makeSellTx(299_330n, 1_010_000n);
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

    // ── 35. A STAMPED attempt whose receipt can never be booked used to stay PENDING for ever — and
    //       hold a slot in the sweep's oldest-50 window. One sweep retires it now.
    walletRaw = 0n; // the build funds a token account: a dead attempt must not leave that row behind
    blockhashSeed = 25;
    height = 900;
    const stuck = await buy();
    const stuckSig = await submitSigned(userId!, stuck.attemptId, await signAsUser(stuck.swapTransaction));
    TXS[stuckSig] = makeTx(999_999n, 299_330n); // landed, but not the swap this attempt built
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
    assert.ok(stuckSweep.failed >= 1);
    assert.strictEqual(
      (await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: stuck.attemptId } })).status,
      "FAILED",
      "the sweep retires a stamped attempt whose receipt can never be booked",
    );
    assert.strictEqual(
      await prisma.sponsorFundedAccount.count({ where: { attemptId: stuck.attemptId } }),
      0,
      "...and the account it never opened is off the books",
    );

    // ── 36. The public health probe coalesces: five concurrent misses do ONE refresh, not five
    //       (four DB reads plus the sponsor balance each).
    const health = await import("../src/app/api/stocks/health/route");
    getBalanceCalls = 0;
    const probes = await Promise.all(Array.from({ length: 5 }, () => health.GET()));
    assert.strictEqual(getBalanceCalls, 1, "one sponsor balance read for five concurrent probes");
    const bodies = (await Promise.all(probes.map((r) => r.json()))) as unknown[];
    for (const b of bodies) assert.deepStrictEqual(b, bodies[0], "every probe gets the same answer");

    // 24. A stamped BUY past its block height is RESOLVED before another buy of the same asset is built
    //     (Astra 2026-09-18 P1: the phone has no pending replay, so a lost confirm + a retry inside the
    //     sweep window must not become two lots).
    {
      const meB = { id: userId!, stockConsentVersion: STOCK_TERMS_VERSION };
      const mkStamped = (sig: string, tag: string) =>
        prisma.stockBuyAttempt.create({
          data: {
            userId: userId!,
            assetId: assetId!,
            payer: PAYER,
            stakeCents: 100,
            inAmountMicro: 1_000_000n,
            minOutBase: 297_834n,
            msgHash: `landed-${tag}`,
            lastValidBlockHeight: 1000n,
            sponsored: true,
            sig,
          },
        });
      await prisma.stockBuyAttempt.deleteMany({ where: { userId: userId!, assetId: assetId!, kind: "BUY", status: "PENDING" } });
      usdcRaw = 100_000_000n;
      walletRaw = 0n;
      const buyAgain = () => buildAttempt(meB, { assetId: assetId!, stakeCents: 100, payer: PAYER });

      // 24a. Still inside the block-height window -> buy_in_flight (unchanged behaviour).
      const inFlight = await mkStamped(SIG_LANDED, "a");
      height = 900;
      await assert.rejects(buyAgain(), (e: unknown) => (e as Error).message === "buy_in_flight");

      // 24b. Past the window and the tx LANDED (confirm was lost) -> the lot is booked now, rebuild refused.
      height = 2000;
      TXS[SIG_LANDED] = makeTx(1_000_000n, 299_330n);
      await assert.rejects(buyAgain(), (e: unknown) => (e as Error).message === "buy_landed");
      assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: inFlight.id } })).status, "CONFIRMED");
      const landedLot = await prisma.stockPosition.findUniqueOrThrow({ where: { attemptId: inFlight.id } });
      assert.strictEqual(landedLot.qtyBase, 299_330n);
      // The same tap again: nothing stamped is pending any more -> a fresh buy IS built.
      const fresh = await buyAgain();
      assert.ok(fresh.attemptId, "a new attempt after the landed one was booked");
      await prisma.stockBuyAttempt.update({ where: { id: fresh.attemptId }, data: { status: "EXPIRED" } });

      // 24c. Past the window and NOT on chain -> the sweep's problem; a fresh buy is allowed.
      const ghost = await mkStamped(SIG_GHOST, "c");
      const fresh2 = await buyAgain();
      assert.ok(fresh2.attemptId && fresh2.attemptId !== ghost.id);
      assert.strictEqual((await prisma.stockBuyAttempt.findUniqueOrThrow({ where: { id: ghost.id } })).status, "PENDING");
      await prisma.stockBuyAttempt.updateMany({ where: { id: { in: [ghost.id, fresh2.attemptId] } }, data: { status: "EXPIRED" } });
    }

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
