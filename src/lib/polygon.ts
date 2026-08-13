// Minimal Polygon JSON-RPC over fetch — the poller stays zero-EVM-deps (no viem/ethers; plan §2.5).
// Balance reads pin the "finalized" tag: deposit detection must never act on reorg-able state.
// publicnode is the one free RPC the spike verified for useful access (poly-spike, 2026-08-12).

const RPC = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";

// Spike-verified token addresses (poly-spike/balance.mjs, checked against production 2026-08-12):
// the bridge lands USDC.e; only pUSD is tradeable collateral (CLOB reports 0 on unwrapped USDC.e).
export const PUSD_ADDRESS = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
export const USDCE_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

export type BalanceReader = (token: string, holder: string) => Promise<bigint>;

// ERC-20 balanceOf(address) — selector 0x70a08231, holder left-padded to 32 bytes.
export const erc20BalanceOf: BalanceReader = async (token, holder) => {
  const data = "0x70a08231" + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: token, data }, "finalized"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`polygon rpc ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error || !body.result) throw new Error(`polygon rpc: ${body.error?.message ?? "empty result"}`);
  return BigInt(body.result);
};
