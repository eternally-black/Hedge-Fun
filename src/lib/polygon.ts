// Minimal Polygon JSON-RPC over fetch — the poller stays zero-EVM-deps (no viem/ethers; plan §2.5).
// Balance reads pin the "finalized" tag: deposit detection must never act on reorg-able state.
// publicnode is the one free RPC the spike verified for useful access (poly-spike, 2026-08-12).

const RPC = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";

// Spike-verified token addresses (poly-spike/balance.mjs, checked against production 2026-08-12):
// the bridge lands USDC.e; only pUSD is tradeable collateral (CLOB reports 0 on unwrapped USDC.e).
export const PUSD_ADDRESS = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
export const USDCE_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

export type BalanceReader = (token: string, holder: string) => Promise<bigint>;

// One fetch+parse for every read — same errors, same 10s bound, whatever the method.
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`polygon rpc ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error || body.result === undefined || body.result === null) {
    throw new Error(`polygon rpc: ${body.error?.message ?? "empty result"}`);
  }
  return body.result;
}

async function ethCall(to: string, data: string): Promise<string> {
  return (await rpc("eth_call", [{ to, data }, "finalized"])) as string;
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

// ERC-1155 balanceOf(owner, id) — 0x00fdd58e. The outcome-token holding of a Deposit Wallet, and
// the PROOF a redemption actually happened: Polymarket's auto-redeemer (an operator we grant during
// activation) burns the position and sends the collateral, so a resolved market whose token balance
// has gone to zero is money that has landed. Booking a win on the market's resolution alone would
// be writing collateral into the ledger before anything moved it.
export async function erc1155BalanceOf(token: string, owner: string, tokenId: string): Promise<bigint> {
  const id = BigInt(tokenId).toString(16).padStart(64, "0");
  return BigInt(await ethCall(token, "0x00fdd58e" + padAddr(owner) + id));
}

// ------------------------------------------------------------------ deposit attribution (§2.5)
// Transfer(address,address,uint256) — the ERC-20 event a deposit actually IS. Balance deltas are
// an inference: any outflow masks them, any inflow fires them. A log names the transaction.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// The finalized head — never eth_blockNumber, which returns the reorg-able tip.
export async function finalizedBlockNumber(): Promise<bigint> {
  const block = (await rpc("eth_getBlockByNumber", ["finalized", false])) as { number?: string };
  if (!block?.number) throw new Error("polygon rpc: finalized block has no number");
  return BigInt(block.number);
}

// Incoming ERC-20 value to `holder` over an INCLUSIVE block range. The caller bounds the span —
// free RPC endpoints reject wide ranges — and walks the cursor forward across polls. Both ends are
// finalized, so re-scanning a range can never double-count a reorged transfer.
export async function erc20IncomingSince(
  token: string,
  holder: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ totalMicro: bigint; transfers: number; lastTxHash: string | null }> {
  const result = await rpc("eth_getLogs", [
    {
      address: token,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: [TRANSFER_TOPIC, null, "0x" + padAddr(holder)],
    },
  ]);
  if (!Array.isArray(result)) throw new Error("polygon rpc: eth_getLogs did not return a list");
  let totalMicro = 0n;
  let lastTxHash: string | null = null;
  for (const raw of result as Array<{ data?: string; transactionHash?: string }>) {
    // A malformed entry contributes nothing rather than aborting the scan; "0x" alone is not a number.
    if (typeof raw.data === "string" && raw.data.length > 2) totalMicro += BigInt(raw.data);
    if (typeof raw.transactionHash === "string") lastTxHash = raw.transactionHash;
  }
  return { totalMicro, transfers: result.length, lastTxHash };
}
