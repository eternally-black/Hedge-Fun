// Turning the bridge's two raw responses into the list a deposit screen can actually render.
//
// The bridge answers /deposit with FOUR addresses — `evm`, `svm`, `tron`, `btc` — one per address
// family, not one per chain: every EVM chain it supports shares a single 0x address. /supported-
// assets separately lists ~229 assets across 13 chains. Neither response alone can drive a network
// picker, and getting the join wrong means showing someone an address on a chain it does not serve,
// which is the one mistake in this flow nobody can undo. Hence a pure function with a test.
import { DEPOSIT_FLOOR_USD } from "./config";
import type { BridgeAsset } from "./bridge";

// The only non-EVM chains the bridge serves. Everything else it lists is EVM (Arbitrum, Base, BNB,
// Ethereum, HyperEVM, Ink, Monad, Optimism, Polygon, Robinhood) and shares the `evm` address.
// Solana's id is a huge STRING and must never be parsed as a number.
const ADDRESS_FAMILY: Record<string, "svm" | "tron" | "btc"> = {
  "1151111081099710": "svm",
  "728126428": "tron",
  "8253038": "btc",
};

// Deliberately not offered. Both carry a $7 bridge floor against our $5 story, both are slow, and
// neither is a plausible way for this app's users to arrive — Tron is USDT-only and Bitcoin has no
// stablecoin at all, so a deposit there is an unhedged price bet between send and settle.
const EXCLUDED_CHAIN_IDS = new Set(["728126428", "8253038"]);

// Shown by name on the chain row. Everything else the bridge accepts still works — it swaps into
// USDC on the way through — but naming the stablecoins is what answers "what can I send here".
const STABLE_SYMBOLS = new Set(["USDC", "USDC.e", "USDT", "USDbC", "DAI", "USDS", "PYUSD"]);

// Solana leads because it is where this app's users actually hold stables — the first row should be
// the one most people will pick, not the one that is technically cheapest to service. Polygon next:
// it is the DESTINATION chain, so a deposit there is already home and skips the bridge hop. The rest
// fall back to name order, which is stable enough to not reshuffle the list every load.
const LEAD_CHAIN_IDS = ["1151111081099710", "137"];

export type DepositChain = {
  chainId: string;
  name: string;
  address: string;
  minUsd: number;
  stables: string[];
};

/**
 * Join the asset list to the address map.
 *
 * `addresses` is the bridge's `address` object verbatim. A chain whose address family is missing
 * from it is DROPPED rather than defaulted: an absent `svm` key means the bridge did not issue a
 * Solana address for this wallet, and falling back to the EVM one would publish an address that
 * cannot receive what the row invites.
 */
export function depositChains(assets: BridgeAsset[], addresses: Record<string, unknown>): DepositChain[] {
  const byChain = new Map<string, { name: string; minUsd: number; stables: Set<string> }>();

  for (const a of assets) {
    if (EXCLUDED_CHAIN_IDS.has(a.chainId)) continue;
    let entry = byChain.get(a.chainId);
    if (!entry) {
      entry = { name: a.chainName, minUsd: 0, stables: new Set() };
      byChain.set(a.chainId, entry);
    }
    // The HIGHEST advertised minimum on the chain: assets on one chain have shared a single value
    // every time it has been sampled, but taking the max means a future outlier under-promises
    // rather than strands a deposit below a floor we quoted too low.
    entry.minUsd = Math.max(entry.minUsd, a.minUsd);
    if (STABLE_SYMBOLS.has(a.symbol)) entry.stables.add(a.symbol);
  }

  const out: DepositChain[] = [];
  for (const [chainId, entry] of byChain) {
    const address = addresses[ADDRESS_FAMILY[chainId] ?? "evm"];
    if (typeof address !== "string" || address.length === 0) continue;
    out.push({
      chainId,
      name: entry.name,
      address,
      // Never below our own floor. The bridge advertises $2 on most chains, but the real Solana
      // floor measured $3 and moved inside a day — a deposit under the true floor parks silently
      // and indefinitely, which to the person who sent it is indistinguishable from theft.
      minUsd: Math.max(entry.minUsd, DEPOSIT_FLOOR_USD),
      stables: [...entry.stables].sort(),
    });
  }

  return out.sort((a, b) => {
    const ai = LEAD_CHAIN_IDS.indexOf(a.chainId);
    const bi = LEAD_CHAIN_IDS.indexOf(b.chainId);
    if (ai !== bi) return (ai < 0 ? LEAD_CHAIN_IDS.length : ai) - (bi < 0 ? LEAD_CHAIN_IDS.length : bi);
    return a.name.localeCompare(b.name);
  });
}
