// The Polymarket bridge, withdrawal half. We already use its deposit half
// (/api/real/deposit-address); this is the same plain-HTTP service in the other direction. No SDK.
//
// Two traps live here. (1) The address a withdrawal returns is SINGLE-PURPOSE — it forwards
// whatever lands on it to the recipient it was created for — so it must be created only when the
// user is about to send, never speculatively. (2) Whatever the destination chain is, the pUSD
// always goes to the `evm` address: our deposit wallet lives on Polygon, and the `svm`/`btc`/`tron`
// entries in the same response are for deposits, not for us.
const BASE = "https://bridge.polymarket.com";
const TIMEOUT_MS = 10_000;
const ASSETS_TTL_MS = 24 * 60 * 60 * 1000;

export type BridgeAsset = {
  chainId: string; // a STRING, and Solana's is "1151111081099710" — never parse it as a number
  chainName: string;
  symbol: string;
  tokenAddress: string; // a Solana mint on Solana entries, so nothing may assume 0x-hex
  decimals: number;
  minUsd: number;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`bridge_unavailable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`bridge_unavailable: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("bridge_bad_response: not json");
  }
}

let assetsCache: { at: number; data: BridgeAsset[] } | null = null;

// Only a successful read is cached — a transient failure must not poison the module for a day.
export async function fetchSupportedAssets(): Promise<BridgeAsset[]> {
  if (assetsCache && Date.now() - assetsCache.at < ASSETS_TTL_MS) return assetsCache.data;

  const raw = await call("/supported-assets");
  if (!isObject(raw) || !Array.isArray(raw.supportedAssets)) {
    throw new Error("bridge_bad_response: supportedAssets missing");
  }
  const data: BridgeAsset[] = [];
  for (const entry of raw.supportedAssets) {
    if (!isObject(entry) || !isObject(entry.token)) continue; // a single malformed row must not kill the list
    const { chainId, chainName, minCheckoutUsd } = entry;
    const { symbol, address, decimals } = entry.token;
    if (
      typeof chainId !== "string" ||
      typeof chainName !== "string" ||
      typeof symbol !== "string" ||
      typeof address !== "string" ||
      typeof decimals !== "number"
    ) {
      continue;
    }
    // minUsd is the ONLY thing standing between a dust withdrawal and money parked below the
    // bridge's real floor forever (the deposit side hard-floors for the same reason). A row that
    // stops carrying it is malformed like the arms above — dropping it beats defaulting to 0,
    // which silently disables the minimum.
    if (typeof minCheckoutUsd !== "number" || !Number.isFinite(minCheckoutUsd)) continue;
    data.push({
      chainId,
      chainName,
      symbol,
      tokenAddress: address,
      decimals,
      minUsd: minCheckoutUsd,
    });
  }
  if (data.length === 0) throw new Error("bridge_bad_response: no usable assets");
  assetsCache = { at: Date.now(), data };
  return data;
}

export async function createWithdrawal(req: {
  wallet: string;
  toChainId: string;
  toTokenAddress: string;
  recipientAddr: string;
}): Promise<{ evmAddress: string }> {
  const code = process.env.POLYMARKET_BUILDER_CODE; // PUBLIC attribution tag, not a secret
  const raw = await call("/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(code ? { "X-Builder-Code": code } : {}) },
    body: JSON.stringify({
      address: req.wallet,
      toChainId: req.toChainId,
      toTokenAddress: req.toTokenAddress,
      recipientAddr: req.recipientAddr,
    }),
  });
  if (!isObject(raw) || !isObject(raw.address)) throw new Error("bridge_bad_response: no address in withdraw");
  const evm = raw.address.evm;
  // This address is where real money is about to be sent; a malformed one must never reach a
  // signing prompt, and the guard on the device compares against exactly this string.
  if (typeof evm !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(evm)) {
    throw new Error("bridge_bad_response: address.evm is not an EVM address");
  }
  return { evmAddress: evm };
}

// The path takes the BRIDGE address from createWithdrawal, not the user's wallet.
export async function fetchWithdrawalStatus(
  bridgeAddress: string,
): Promise<{ status: string | null; txHash: string | null; raw: unknown }> {
  const raw = await call(`/status/${encodeURIComponent(bridgeAddress)}`);
  if (!isObject(raw) || !Array.isArray(raw.transactions)) {
    throw new Error("bridge_bad_response: transactions missing");
  }
  const rows = raw.transactions.filter(isObject);
  const at = (tx: Record<string, unknown>) => (typeof tx.createdTimeMs === "number" ? tx.createdTimeMs : 0);
  const newest = rows.length > 0 ? rows.reduce((a, b) => (at(b) >= at(a) ? b : a)) : null;
  return {
    status: newest && typeof newest.status === "string" ? newest.status : null,
    txHash: newest && typeof newest.txHash === "string" ? newest.txHash : null,
    raw,
  };
}
