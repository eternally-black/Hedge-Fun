// Joining the bridge's asset list to its address map — the step that decides which address a person
// is told to send money to.
//
// This has a test because the join is where the whole deposit flow can go quietly wrong. The bridge
// answers /deposit with FOUR addresses keyed by FAMILY (evm/svm/tron/btc), not one per chain, while
// /supported-assets lists 13 chains; pairing a chain with the wrong family publishes an address that
// cannot receive what the row invites, and nobody finds out until the funds are gone.
//
// Run: npx tsx scripts/test-deposit-chains.ts
import assert from "node:assert/strict";
import { depositChains } from "../src/lib/deposit-chains";
import { DEPOSIT_FLOOR_USD } from "../src/lib/config";
import type { BridgeAsset } from "../src/lib/bridge";

const EVM = "0xFE7644Df08fE11599A50e5C75F5Fb458a5a3EF06";
const SVM = "GtkDxNNiLxgSLg8dWYzfjY5eNHYtGZEg9AZjaBVCLXNH";
const TRON = "TY22ApL1VPt5NhYwGfCRof3oL7N77uRWPa";
const BTC = "bc1qe2cegx70ve59tm4d9krnczm34q4l5pv9mzkl76";
const ADDRESSES = { evm: EVM, svm: SVM, tron: TRON, btc: BTC };

const asset = (chainId: string, chainName: string, symbol: string, minUsd: number): BridgeAsset => ({
  chainId,
  chainName,
  symbol,
  tokenAddress: "0xtoken",
  decimals: 6,
  minUsd,
});

// Shaped after the live response (2026-08-17): Polygon/Solana/Base advertise $2, Ethereum $5, and
// Bitcoin/Tron $7.
const ASSETS: BridgeAsset[] = [
  asset("137", "Polygon", "USDC", 2),
  asset("137", "Polygon", "USDT", 2),
  asset("137", "Polygon", "WBTC", 2),
  asset("1151111081099710", "Solana", "USDC", 2),
  asset("1151111081099710", "Solana", "SOL", 2),
  asset("8453", "Base", "USDC", 2),
  asset("1", "Ethereum", "USDC", 5),
  asset("728126428", "Tron", "USDT", 7),
  asset("8253038", "Bitcoin", "BTC", 7),
];

const byId = (chains: ReturnType<typeof depositChains>, id: string) => chains.find((c) => c.chainId === id);

function main() {
  const chains = depositChains(ASSETS, ADDRESSES);

  // ── Address FAMILY, not chain: every EVM chain shares one 0x address, Solana gets the svm one ───
  assert.equal(byId(chains, "137")?.address, EVM, "Polygon takes the evm address");
  assert.equal(byId(chains, "8453")?.address, EVM, "…and so does Base, from the same key");
  assert.equal(byId(chains, "1")?.address, EVM, "…and Ethereum");
  assert.equal(byId(chains, "1151111081099710")?.address, SVM, "Solana takes the svm address");

  // ── Bitcoin and Tron are not offered, however loudly the bridge lists them ──────────────────────
  assert.equal(byId(chains, "8253038"), undefined, "Bitcoin is excluded");
  assert.equal(byId(chains, "728126428"), undefined, "Tron is excluded");
  assert.ok(
    !chains.some((c) => c.address === BTC || c.address === TRON),
    "no row may carry an excluded chain's address",
  );

  // ── The floor is ours, not the bridge's: never advertise below it ───────────────────────────────
  assert.ok(
    chains.every((c) => c.minUsd >= DEPOSIT_FLOOR_USD),
    "the advertised $2 never reaches the screen",
  );
  // …but a chain that demands MORE keeps its own number rather than being flattened down to ours.
  const pricey = depositChains([asset("42161", "Arbitrum", "USDC", 9)], ADDRESSES);
  assert.equal(pricey[0]?.minUsd, 9, "a higher chain minimum survives the floor");

  // ── Stablecoins are named; everything else the bridge swaps is not the answer to "what do I send" ─
  assert.deepEqual(byId(chains, "137")?.stables, ["USDC", "USDT"], "WBTC is not a stablecoin");
  assert.deepEqual(byId(chains, "1151111081099710")?.stables, ["USDC"], "SOL is not either");

  // ── A missing address family DROPS the chain rather than falling back to evm ────────────────────
  // Silently defaulting would print a Polygon 0x address on a Solana row: the exact mistake in this
  // flow that cannot be undone.
  const noSvm = depositChains(ASSETS, { evm: EVM });
  assert.equal(byId(noSvm, "1151111081099710"), undefined, "no svm key -> no Solana row");
  assert.ok(byId(noSvm, "137"), "…while the EVM chains are unaffected");
  assert.equal(depositChains(ASSETS, {}).length, 0, "no addresses at all -> nothing to show");

  // ── Polygon leads: it is the destination chain, so a deposit there skips the bridge hop ─────────
  assert.equal(chains[0]?.chainId, "137", "Polygon first");
  assert.equal(chains[1]?.chainId, "1151111081099710", "Solana second");

  console.log("OK: chains map to the right address family, excluded chains never surface, floor holds");
  console.log("PASS: deposit-chains");
}

main();
