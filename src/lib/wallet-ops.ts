// Wrap calldata — ported from poly-spike/wrap.mjs, which recovered the recipe byte-for-byte from
// polymarket.com's own transaction (tx 0x451fe401…c56406): the bridge delivers USDC.e, the CLOB
// counts only pUSD, and the SDK has no wrap function. Two calls batched atomically through the
// Deposit Wallet execute path (prepareGaslessTransaction). Approving the EXACT amount (never max)
// is deliberate — no standing allowance, same as the frontend.
// No viem: selectors + abi-encoding by hand, pinned by a byte-for-byte test against the recorded
// production calldata (scripts/test-wallet-ops.ts — the wrap.mjs --check fixture).
import { USDCE_ADDRESS } from "./polygon";

export const COLLATERAL_ONRAMP = "0x93070a847efef7f70739046a929d47a521f5b8ee"; // docs /concepts/pusd

const addr = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const uint = (n: bigint) => n.toString(16).padStart(64, "0");

export type WalletCall = { to: string; data: string };

// 1. USDC.e.approve(CollateralOnramp, amount)   selector 0x095ea7b3
// 2. CollateralOnramp.wrap(USDC.e, wallet, amount)  selector 0x62355638
export function buildWrapCalls(wallet: string, amountMicro: bigint): WalletCall[] {
  return [
    { to: USDCE_ADDRESS, data: "0x095ea7b3" + addr(COLLATERAL_ONRAMP) + uint(amountMicro) },
    { to: COLLATERAL_ONRAMP, data: "0x62355638" + addr(USDCE_ADDRESS) + addr(wallet) + uint(amountMicro) },
  ];
}
