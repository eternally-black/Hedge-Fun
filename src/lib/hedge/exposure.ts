// Exposure reader — PURE core (D3: exposure = current MARKET VALUE, never cost basis). Turns raw
// wallet balances (Helius) × current prices (Jupiter) into per-asset USD notional in integer cents,
// splitting MAJORS (SOL / wrapped BTC / wrapped ETH — directly hedgeable) from long-tail SPL (summed
// into one proxy-hedge basis). DB-free / network-free — unit-tested in scripts/test-hedge-cores.ts.

import type { HedgeAsset } from "./parse";

// Jupiter prices wSOL's mint = the SOL price, so native SOL (no mint) is looked up under this key.
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Curated wrapped/bridged major mints on Solana (verified as the common ones, 2026-07). This list is
// intentionally small and MUST be widened from a maintained token list before REAL money — for paper
// S1 an unknown wrapped-major mint just falls into the SPL proxy bucket, which is safe (never a wrong
// direct hedge). Native SOL is handled separately (mint === null).
export const MAJOR_MINTS: Record<string, HedgeAsset> = {
  [WSOL_MINT]: "SOL",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "BTC", // WBTC (Wormhole)
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: "BTC", // cbBTC (Coinbase)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH", // WETH (Wormhole)
};

// One raw holding. mint === null => native SOL. uiAmount = decimal token units (raw / 10^decimals).
export interface TokenBalance {
  mint: string | null;
  symbol?: string | null;
  uiAmount: number;
}

// mint -> USD price per token (native SOL priced under WSOL_MINT). Missing mint => treated as $0.
export type PriceMap = Record<string, number>;

export interface ExposureAsset {
  asset: string; // "SOL" | "BTC" | "ETH" for majors; symbol or short mint for SPL
  mint: string | null; // null for the merged SOL major (native); representative mint otherwise
  amount: number; // UI token units (majors merge native SOL + wSOL)
  priceCents: number; // USD price per token, integer cents (display only)
  notionalCents: number; // current USD value, integer cents (the load-bearing number)
  isMajor: boolean;
}

export interface ExposureResult {
  assets: ExposureAsset[]; // every priced holding, per mint
  majors: ExposureAsset[]; // SOL/BTC/ETH, MERGED per asset (native SOL + wSOL collapse to one SOL row)
  splAggregateCents: number; // Σ non-major notional (the proxy-hedge basis)
  totalNotionalCents: number;
}

function classify(mint: string | null): HedgeAsset | null {
  if (mint === null) return "SOL"; // native SOL
  return MAJOR_MINTS[mint] ?? null;
}

export function exposureFromBalances(balances: TokenBalance[], prices: PriceMap): ExposureResult {
  const assets: ExposureAsset[] = [];
  const majorAcc = new Map<HedgeAsset, ExposureAsset>();
  let splAggregateCents = 0;
  let totalNotionalCents = 0;

  for (const b of balances) {
    if (!(b.uiAmount > 0)) continue; // skip empty / dust-zero token accounts
    const priceKey = b.mint ?? WSOL_MINT;
    const price = prices[priceKey] ?? 0;
    const notionalCents = Math.round(b.uiAmount * price * 100);
    if (notionalCents <= 0) continue; // unpriced -> no exposure signal
    const major = classify(b.mint);

    const row: ExposureAsset = {
      asset: major ?? (b.symbol || (b.mint ? b.mint.slice(0, 4) : "SOL")),
      mint: b.mint,
      amount: b.uiAmount,
      priceCents: Math.round(price * 100),
      notionalCents,
      isMajor: major !== null,
    };
    assets.push(row);
    totalNotionalCents += notionalCents;

    if (major) {
      const cur = majorAcc.get(major);
      if (cur) {
        cur.amount += b.uiAmount;
        cur.notionalCents += notionalCents;
      } else {
        majorAcc.set(major, {
          asset: major,
          mint: major === "SOL" ? null : b.mint, // SOL major represents native
          amount: b.uiAmount,
          priceCents: Math.round(price * 100),
          notionalCents,
          isMajor: true,
        });
      }
    } else {
      splAggregateCents += notionalCents;
    }
  }

  // Majors sorted by notional desc so the biggest holding leads the suggestions.
  const majors = [...majorAcc.values()].sort((a, b) => b.notionalCents - a.notionalCents);
  return { assets, majors, splAggregateCents, totalNotionalCents };
}
