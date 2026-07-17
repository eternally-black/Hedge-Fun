// Helius wallet-balances integration (read-only — no keys, no signing). One call to the Enhanced
// Balances API returns native SOL + every SPL token account with decimals, which we normalize into
// the TokenBalance[] the pure exposure core consumes. HELIUS_API_KEY env. Follows the polymarket.ts
// style: verified-facts header, typed error on failure so the route degrades deliberately.
//
// Verified facts (Helius Enhanced Balances, https://docs.helius.dev):
//  - GET https://api.helius.xyz/v0/addresses/{address}/balances?api-key=KEY
//  - { nativeBalance: <lamports:number>, tokens: [{ mint, amount:<raw>, decimals }] }
//  - nativeBalance is in LAMPORTS (÷ 1e9 = SOL); token amount is RAW (÷ 10^decimals = uiAmount).

import type { TokenBalance } from "./hedge/exposure";

const BASE = process.env.HELIUS_API_BASE ?? "https://api.helius.xyz";
const TIMEOUT_MS = 10_000;

// Thrown when Helius can't answer (missing key, HTTP error, timeout). The wallet route turns this
// into a 502 — without balances there is no exposure and no suggestion to render.
export class HeliusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeliusUnavailableError";
  }
}

interface HeliusBalancesResponse {
  nativeBalance?: number; // lamports
  tokens?: { mint?: string; amount?: number; decimals?: number }[];
}

// Fetch native SOL + SPL balances for a Solana address, normalized to TokenBalance[] (native SOL is
// mint === null). Throws HeliusUnavailableError on any failure — never returns a partial/guessed set.
export async function getWalletBalances(address: string): Promise<TokenBalance[]> {
  const key = (process.env.HELIUS_API_KEY ?? "").trim();
  if (!key) throw new HeliusUnavailableError("HELIUS_API_KEY not set");

  const url = `${BASE}/v0/addresses/${encodeURIComponent(address)}/balances?api-key=${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let json: HeliusBalancesResponse;
  try {
    const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new HeliusUnavailableError(`Helius ${res.status}`);
    json = (await res.json()) as HeliusBalancesResponse;
  } catch (e) {
    if (e instanceof HeliusUnavailableError) throw e;
    throw new HeliusUnavailableError(`Helius fetch failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }

  const out: TokenBalance[] = [];
  const lamports = json.nativeBalance ?? 0;
  if (lamports > 0) out.push({ mint: null, symbol: "SOL", uiAmount: lamports / 1e9 });

  for (const tk of json.tokens ?? []) {
    if (!tk.mint || typeof tk.amount !== "number") continue;
    const decimals = tk.decimals ?? 0;
    const uiAmount = tk.amount / 10 ** decimals;
    if (uiAmount > 0) out.push({ mint: tk.mint, symbol: null, uiAmount });
  }
  return out;
}
