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

import { JupiterUnavailableError } from "./prices";
import { parseJupQuote, type JupQuoteParsed } from "./stocks";
import { deadlineLeftMs, boundedTimeoutMs } from "./deadline";

const BASE = process.env.JUPITER_SWAP_BASE ?? "https://lite-api.jup.ag/swap/v1";
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
}): Promise<SwapQuote> {
  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    slippageBps: String(p.slippageBps),
    swapMode: "ExactIn",
  });
  const json = await jupFetch(`${BASE}/quote?${qs.toString()}`);
  const parsed = parseJupQuote(json);
  if (!parsed) throw new JupiterUnavailableError("quote_unparseable");
  return { ...parsed, raw: json };
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
