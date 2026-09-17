// Jupiter Lite Swap v1 (keyless) — the REAL tokenized-stock buy path. Two calls: /quote prices an
// ExactIn USDC -> xStock swap, /swap turns that quote into a base64 VersionedTransaction the user's
// own wallet signs. We never hold keys and never sign; the server only BUILDS, and the chain is the
// receipt (see stocks-real.ts). Follows prices.ts: verified-facts header, deadline-aware timeouts,
// typed error so the route degrades to a deliberate 502.
//
// Verified facts (Jupiter Lite Swap v1, verified live 2026-09-14):
//  - GET  ${BASE}/quote?inputMint=&outputMint=&amount=<raw>&slippageBps=&swapMode=ExactIn
//      -> { inAmount, outAmount, otherAmountThreshold, priceImpactPct, routePlan, ... }
//  - POST ${BASE}/swap  JSON { quoteResponse, userPublicKey, wrapAndUnwrapSol: true,
//      dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }
//      -> { swapTransaction: <base64 VersionedTransaction>, lastValidBlockHeight: <number> }
//  - No API key at our volumes (lite-api). A non-2xx / timeout is an outage, not a bad quote.
//
// Verified facts (Jupiter Lite Swap v1 /swap-instructions, verified live 2026-09-15, USDC -> AAPLx
// 1.0 USDC, slippage 50 bp — the FEE-SPONSORED path, where we assemble the tx ourselves):
//  - POST ${BASE}/swap-instructions, same body as /swap, with
//      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports, priorityLevel: "medium" } }
//      ACCEPTED (the response echoed prioritizationFeeLamports: 99999 for maxLamports 100000).
//  - -> { computeBudgetInstructions: Ix[2], setupInstructions: Ix[0..2], swapInstruction: Ix,
//         cleanupInstruction: Ix | null, otherInstructions: Ix[] (empty in practice),
//         addressLookupTableAddresses: string[2], tokenLedgerInstruction: null,
//         computeUnitLimit, prioritizationType, simulationError, blockhashWithMetadata, ... }
//      Ix = { programId: base58, accounts: [{ pubkey, isSigner, isWritable }], data: base64 }.
//  - setupInstructions are ATA creations (programId ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL)
//      whose accounts[0] is the FUNDING PAYER (isSigner true, isWritable true) — the one account the
//      sponsor takes over so the ~0.00157 SOL of rent comes from us, not from the user.
//  - cleanupInstruction on this route is an SPL-Token CloseAccount (data = [9], accounts =
//      [account(w), destination(w), owner(signer)]) — the same 3-account/1-byte shape our own
//      close-the-emptied-xStock-account instruction uses on the SELL path.
//  - addressesByLookupTableAddress came back null, so the tables are resolved via the RPC.

import { JupiterUnavailableError } from "./prices";
import { parseJupQuote, type JupQuoteParsed } from "./stocks";
import { deadlineLeftMs, boundedTimeoutMs } from "./deadline";

const BASE = process.env.JUPITER_SWAP_BASE || "https://lite-api.jup.ag/swap/v1";
const TIMEOUT_MS = 10_000;

export interface SwapQuote extends JupQuoteParsed {
  raw: unknown; // the verbatim quote response — POSTed back to /swap, never re-derived
}

// One deadline-aware fetch. Refuses once the poller's budget is spent (same contract as prices.ts)
// and clamps its own timeout to what is left, so a slow Jupiter can never outlive the tick.
async function jupFetch(url: string, init?: RequestInit): Promise<unknown> {
  const left = deadlineLeftMs();
  if (left !== undefined && left <= 0) throw new JupiterUnavailableError("Jupiter time budget exhausted");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), boundedTimeoutMs(TIMEOUT_MS));
  try {
    const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" }, ...init, signal: ctrl.signal });
    if (!res.ok) throw new JupiterUnavailableError(`Jupiter ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof JupiterUnavailableError) throw e;
    throw new JupiterUnavailableError(`Jupiter fetch failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

// Price an ExactIn USDC -> xStock swap. A quote we cannot fully parse is a quote we must not sign,
// so an unparseable body is an outage (502), never a partial quote.
export async function quoteSwap(p: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  onlyDirectRoutes?: boolean;
}): Promise<SwapQuote> {
  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    slippageBps: String(p.slippageBps),
    swapMode: "ExactIn",
    ...(p.onlyDirectRoutes ? { onlyDirectRoutes: "true" } : {}),
  });
  const json = await jupFetch(`${BASE}/quote?${qs.toString()}`);
  const parsed = parseJupQuote(json);
  if (!parsed) throw new JupiterUnavailableError("quote_unparseable");
  return { ...parsed, raw: json };
}

// A DIRECT route first, any route only when none exists. A route through wrapped SOL makes the
// sponsor open a wSOL account for the user and take its rent back in the same transaction — which
// an external wallet's scanner reads as "your account was closed and the lamports went to a
// stranger" and BLOCKS the request outright (seen live 2026-09-18: NVDAx, direct → Phantom signed;
// AAPLx, via wSOL → "Request blocked"). A direct pool also leaves no intermediate token account
// behind for the sponsor to have paid for. Every liquid xStock has a direct USDC pool; the size of a
// stake here ($1–$500) never needs the extra hop for price.
export async function quoteSwapPreferDirect(p: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<SwapQuote> {
  try {
    return await quoteSwap({ ...p, onlyDirectRoutes: true });
  } catch (e) {
    if (!(e instanceof JupiterUnavailableError)) throw e; // a real outage surfaces from the retry too
  }
  return quoteSwap(p);
}

// Turn a quote into a signable transaction. Both fields are validated here because the caller
// persists lastValidBlockHeight as a BigInt and hands swapTransaction to a wallet — a missing or
// malformed field must fail loudly at build time, not at sign time.
export async function buildSwapTx(
  quoteResponse: unknown,
  userPublicKey: string,
): Promise<{ swapTransaction: string; lastValidBlockHeight: number }> {
  const json = (await jupFetch(`${BASE}/swap`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  })) as { swapTransaction?: unknown; lastValidBlockHeight?: unknown } | null;
  const swapTransaction = json?.swapTransaction;
  const lastValidBlockHeight = json?.lastValidBlockHeight;
  if (typeof swapTransaction !== "string" || swapTransaction.length === 0) {
    throw new JupiterUnavailableError("swap_unparseable");
  }
  if (typeof lastValidBlockHeight !== "number" || !Number.isFinite(lastValidBlockHeight)) {
    throw new JupiterUnavailableError("swap_unparseable");
  }
  return { swapTransaction, lastValidBlockHeight };
}

// ─── /swap-instructions (the FEE-SPONSORED path) ────────────────────────────────────────────────────

// One instruction exactly as Jupiter puts it on the wire. This is also the shape the sponsor builder
// consumes, so a hand-built instruction (the SELL close-account) needs no second representation.
export interface JupIxAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
export interface JupIx {
  programId: string;
  accounts: JupIxAccount[];
  data: string; // base64
}
export interface JupSwapInstructions {
  computeBudgetInstructions: JupIx[];
  setupInstructions: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction: JupIx | null;
  otherInstructions: JupIx[];
  addressLookupTableAddresses: string[];
}

// An instruction we cannot fully read is an instruction we must not sign — so validate every field
// rather than trusting the shape (same rule as parseJupQuote).
function parseIx(v: unknown): JupIx | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { programId?: unknown; accounts?: unknown; data?: unknown };
  if (typeof o.programId !== "string" || !o.programId) return null;
  if (typeof o.data !== "string") return null;
  if (!Array.isArray(o.accounts)) return null;
  const accounts: JupIxAccount[] = [];
  for (const a of o.accounts) {
    const acc = a as { pubkey?: unknown; isSigner?: unknown; isWritable?: unknown };
    if (!acc || typeof acc.pubkey !== "string" || !acc.pubkey) return null;
    accounts.push({ pubkey: acc.pubkey, isSigner: acc.isSigner === true, isWritable: acc.isWritable === true });
  }
  return { programId: o.programId, accounts, data: o.data };
}

function parseIxList(v: unknown): JupIx[] | null {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  const out: JupIx[] = [];
  for (const raw of v) {
    const ix = parseIx(raw);
    if (!ix) return null;
    out.push(ix);
  }
  return out;
}

// The same swap as /swap, but as instructions we compose into OUR transaction (fee payer = the
// sponsor). maxPriorityLamports caps what the sponsor pays for priority on this one tx.
export async function swapInstructions(p: {
  quoteResponse: unknown;
  userPublicKey: string;
  maxPriorityLamports: number;
}): Promise<JupSwapInstructions> {
  const json = (await jupFetch(`${BASE}/swap-instructions`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: p.quoteResponse,
      userPublicKey: p.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: p.maxPriorityLamports, priorityLevel: "medium" },
      },
    }),
  })) as Record<string, unknown> | null;

  const computeBudgetInstructions = parseIxList(json?.computeBudgetInstructions);
  const setupInstructions = parseIxList(json?.setupInstructions);
  const otherInstructions = parseIxList(json?.otherInstructions);
  const swapInstruction = parseIx(json?.swapInstruction);
  const cleanupInstruction = json?.cleanupInstruction == null ? null : parseIx(json.cleanupInstruction);
  const luts = json?.addressLookupTableAddresses;
  if (
    !computeBudgetInstructions ||
    !setupInstructions ||
    !otherInstructions ||
    !swapInstruction ||
    (json?.cleanupInstruction != null && !cleanupInstruction) ||
    (luts != null && !Array.isArray(luts))
  ) {
    throw new JupiterUnavailableError("swap_instructions_unparseable");
  }
  return {
    computeBudgetInstructions,
    setupInstructions,
    swapInstruction,
    cleanupInstruction,
    otherInstructions,
    addressLookupTableAddresses: ((luts as unknown[]) ?? []).filter((a): a is string => typeof a === "string" && a.length > 0),
  };
}
