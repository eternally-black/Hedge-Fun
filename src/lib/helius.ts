// Helius integration (read-only balances + the JSON-RPC the real stock path needs; no keys, no
// signing). Wallet balances = native SOL + every token account under BOTH token programs, normalized
// into the TokenBalance[] the pure exposure core consumes. HELIUS_API_KEY env. Follows the
// polymarket.ts style: verified-facts header, typed error on failure so the route degrades deliberately.
//
// Verified facts (2026-09-15):
//  - Helius' legacy Enhanced Balances endpoint (GET api.helius.xyz/v0/addresses/{addr}/balances) is
//    GONE: 404 {"error":{"message":"Method not found"}} for every address, populated or empty. Balances
//    now come from standard JSON-RPC on the same key:
//  - getBalance [addr, {commitment}] -> { value: <lamports:number> }
//  - getTokenAccountsByOwner [addr, {programId}, {encoding:"jsonParsed", commitment}] ->
//      { value: [{ pubkey, account: { data: { parsed: { info: { mint, tokenAmount: { amount:<raw string>,
//      decimals, uiAmount } } } } } }] } — one call per token program (SPL Token and Token-2022; xStocks
//      are Token-2022), uiAmount already applies the mint's decimals.

import type { TokenBalance } from "./hedge/exposure";
import type { RpcParsedTx } from "./stocks";
import { deadlineLeftMs, boundedTimeoutMs } from "./deadline";

const RPC_BASE = process.env.HELIUS_RPC_BASE ?? "https://mainnet.helius-rpc.com";
const TIMEOUT_MS = 10_000;

// Thrown when Helius can't answer (missing key, HTTP error, timeout). The wallet route turns this
// into a 502 — without balances there is no exposure and no suggestion to render.
export class HeliusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeliusUnavailableError";
  }
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Fetch native SOL + every token balance for a Solana address, normalized to TokenBalance[] (native
// SOL is mint === null). Three RPC reads in parallel; any failure throws HeliusUnavailableError —
// never a partial/guessed set, because a missing token would silently shrink someone's exposure.
export async function getWalletBalances(address: string): Promise<TokenBalance[]> {
  const parsedAccounts = async (programId: string) =>
    (await rpc("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }])) as
      | { value?: { account?: { data?: { parsed?: { info?: { mint?: unknown; tokenAmount?: { uiAmount?: unknown } } } } } }[] }
      | null;
  const [bal, spl, t22] = await Promise.all([
    rpc("getBalance", [address, { commitment: "confirmed" }]) as Promise<{ value?: unknown } | null>,
    parsedAccounts(TOKEN_PROGRAM),
    parsedAccounts(TOKEN_2022_PROGRAM),
  ]);

  const out: TokenBalance[] = [];
  const lamports = typeof bal?.value === "number" ? bal.value : 0;
  if (lamports > 0) out.push({ mint: null, symbol: "SOL", uiAmount: lamports / 1e9 });

  for (const v of [...(spl?.value ?? []), ...(t22?.value ?? [])]) {
    const info = v?.account?.data?.parsed?.info;
    const mint = info?.mint;
    const uiAmount = info?.tokenAmount?.uiAmount;
    if (typeof mint !== "string" || typeof uiAmount !== "number" || !(uiAmount > 0)) continue;
    out.push({ mint, symbol: null, uiAmount });
  }
  return out;
}

// ─── JSON-RPC (the real tokenized-stock buy path) ───────────────────────────────────────────────────
// Same key, a different host: Helius' RPC endpoint speaks standard Solana JSON-RPC. Used to READ a
// landed swap (getTransaction), to recover a swap whose tab died (getSignaturesForAddress +
// getBlockHeight), to reconcile REAL lots against the wallet's live balance, and — for the
// fee-sponsored path — to build (getLatestBlockhash, getAccountInfo for the lookup tables) and SEND
// (sendTransaction) the co-signed swap. Deadline-aware like the balances read. The URL carries the
// api key — it is never part of an error message or a log line.
//
// Verified facts (Solana JSON-RPC via Helius, verified live 2026-09-15):
//  - getLatestBlockhash [{commitment}] -> { context, value: { blockhash: base58, lastValidBlockHeight: number } }
//  - getAccountInfo [addr, {encoding:"base64", commitment}] -> { value: { data: [b64, "base64"], owner, ... } | null }
//  - sendTransaction [b64, {encoding:"base64", ...}] -> base58 signature (an RPC error = not sent)
//  - getBalance [addr, {commitment}] -> { value: <lamports:number> }

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const key = (process.env.HELIUS_API_KEY ?? "").trim();
  if (!key) throw new HeliusUnavailableError("HELIUS_API_KEY not set");
  const left = deadlineLeftMs();
  if (left !== undefined && left <= 0) throw new HeliusUnavailableError(`rpc ${method}: time budget exhausted`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), boundedTimeoutMs(TIMEOUT_MS));
  try {
    const res = await fetch(`${RPC_BASE}/?api-key=${encodeURIComponent(key)}`, {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new HeliusUnavailableError(`rpc ${method}: ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new HeliusUnavailableError(`rpc ${method}: ${json.error.message ?? "error"}`);
    return json.result;
  } catch (e) {
    if (e instanceof HeliusUnavailableError) throw e;
    throw new HeliusUnavailableError(`rpc ${method}: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

// The landed transaction, parsed, or null when it has not landed (yet). maxSupportedTransactionVersion
// is required for the v0 transactions Jupiter builds — without it the RPC answers with an error.
export async function getTransaction(sig: string): Promise<RpcParsedTx | null> {
  const r = await rpc("getTransaction", [
    sig,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
  return (r as RpcParsedTx | null) ?? null;
}

export async function getSignaturesForAddress(
  address: string,
  limit: number,
): Promise<{ signature: string; blockTime: number | null; err: unknown }[]> {
  const r = (await rpc("getSignaturesForAddress", [address, { limit, commitment: "confirmed" }])) as
    | { signature: string; blockTime?: number | null; err?: unknown }[]
    | null;
  return (r ?? []).map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null, err: s.err ?? null }));
}

export async function getBlockHeight(): Promise<number> {
  const r = await rpc("getBlockHeight", [{ commitment: "confirmed" }]);
  if (typeof r !== "number" || !Number.isFinite(r)) throw new HeliusUnavailableError("rpc getBlockHeight: bad result");
  return r;
}

// The owner's token accounts for one mint, with their RAW amounts (a wallet can hold several ATAs).
// The pubkey matters to the SELL path: closing the emptied account returns its rent, and closing the
// account the chain actually shows beats re-deriving an ATA that may not be the one holding the lot.
export async function getTokenAccounts(owner: string, mint: string): Promise<{ pubkey: string; amount: bigint }[]> {
  const r = (await rpc("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ])) as
    | { value?: { pubkey?: string; account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] }
    | null;
  const out: { pubkey: string; amount: bigint }[] = [];
  for (const v of r?.value ?? []) {
    const amount = v?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
    out.push({ pubkey: typeof v?.pubkey === "string" ? v.pubkey : "", amount: BigInt(amount) });
  }
  return out;
}

// Σ RAW token amount across the owner's accounts for one mint. 0n when it holds none. RAW on
// purpose: the Token-2022 ScaledUiAmount multiplier scales only uiAmount.
export async function getTokenBalanceRaw(owner: string, mint: string): Promise<bigint> {
  let total = 0n;
  for (const a of await getTokenAccounts(owner, mint)) total += a.amount;
  return total;
}

// The blockhash a sponsored transaction is built against, plus the height past which it can never
// land (persisted on the attempt so the sweep knows when to stop waiting).
export async function getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const r = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
    value?: { blockhash?: unknown; lastValidBlockHeight?: unknown };
  } | null;
  const blockhash = r?.value?.blockhash;
  const lastValidBlockHeight = r?.value?.lastValidBlockHeight;
  if (typeof blockhash !== "string" || !blockhash) throw new HeliusUnavailableError("rpc getLatestBlockhash: bad result");
  if (typeof lastValidBlockHeight !== "number" || !Number.isFinite(lastValidBlockHeight)) {
    throw new HeliusUnavailableError("rpc getLatestBlockhash: bad result");
  }
  return { blockhash, lastValidBlockHeight };
}

// Raw account bytes + owning program. null when the account does not exist — a MISSING account is an
// answer (an unopened token account), not an outage, so it must not read as one.
export async function getAccountInfoBase64(address: string): Promise<{ data: Uint8Array; owner: string } | null> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }])) as {
    value?: { data?: unknown; owner?: unknown } | null;
  } | null;
  const v = r?.value;
  if (!v) return null;
  const data = Array.isArray(v.data) ? v.data[0] : null;
  if (typeof data !== "string" || typeof v.owner !== "string") {
    throw new HeliusUnavailableError("rpc getAccountInfo: bad result");
  }
  return { data: new Uint8Array(Buffer.from(data, "base64")), owner: v.owner };
}

// Send a fully-signed wire transaction. preflight ON: a swap that would fail on chain costs the
// sponsor a fee for nothing, and the RPC error tells us why. An RPC error means NOT SENT.
export async function sendRawTransaction(base64: string): Promise<string> {
  const r = await rpc("sendTransaction", [
    base64,
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
  ]);
  if (typeof r !== "string" || !r) throw new HeliusUnavailableError("rpc sendTransaction: bad result");
  return r;
}

// Native SOL of one address, in lamports. The ops probe watches the sponsor's balance with this.
export async function getBalanceLamports(address: string): Promise<bigint> {
  const r = (await rpc("getBalance", [address, { commitment: "confirmed" }])) as { value?: unknown } | null;
  const v = r?.value;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HeliusUnavailableError("rpc getBalance: bad result");
  return BigInt(Math.trunc(v));
}
