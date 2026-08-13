// Minimal Polygon JSON-RPC over fetch — the poller stays zero-EVM-deps (no viem/ethers; plan §2.5).
// Balance reads pin the "finalized" tag: deposit detection must never act on reorg-able state.
// publicnode is the one free RPC the spike verified for useful access (poly-spike, 2026-08-12).

const RPC = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";

// Spike-verified token addresses (poly-spike/balance.mjs, checked against production 2026-08-12):
// the bridge lands USDC.e; only pUSD is tradeable collateral (CLOB reports 0 on unwrapped USDC.e).
export const PUSD_ADDRESS = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
export const USDCE_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

export type BalanceReader = (token: string, holder: string) => Promise<bigint>;

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "finalized"] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`polygon rpc ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error || !body.result) throw new Error(`polygon rpc: ${body.error?.message ?? "empty result"}`);
  return body.result;
}

// owner() — selector 0x8da5cb5b. The Deposit Wallet beacon proxy exposes its signer EOA here;
// verified empirically against the spike's deployed pair (owner(0x0b699a09…) == 0xb24380b2…).
// This is the signer↔wallet binding check: one eth_call, no SDK derivation, no extra signature.
export async function contractOwner(wallet: string): Promise<string> {
  const result = await ethCall(wallet, "0x8da5cb5b");
  if (result.length < 66) throw new Error(`owner(): unexpected result ${result}`);
  return ("0x" + result.slice(-40)).toLowerCase();
}

// ERC-20 balanceOf(address) — selector 0x70a08231, holder left-padded to 32 bytes.
export const erc20BalanceOf: BalanceReader = async (token, holder) => {
  const data = "0x70a08231" + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return BigInt(await ethCall(token, data));
};

const padAddr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

// ERC-20 allowance(owner, spender) — 0xdd62ed3e. Chain truth for approvals convergence (§2.4):
// the CLOB's own balance-allowance endpoint is a cached server-side view (trap list).
export async function erc20Allowance(token: string, owner: string, spender: string): Promise<bigint> {
  return BigInt(await ethCall(token, "0xdd62ed3e" + padAddr(owner) + padAddr(spender)));
}

// ERC-1155 isApprovedForAll(owner, operator) — 0xe985e9c5. The SELL-side approval a close needs.
export async function erc1155IsApprovedForAll(token: string, owner: string, operator: string): Promise<boolean> {
  const r = await ethCall(token, "0xe985e9c5" + padAddr(owner) + padAddr(operator));
  return BigInt(r) === 1n;
}
