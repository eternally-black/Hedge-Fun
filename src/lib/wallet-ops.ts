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

// ---------------------------------------------------------------------------- trading approvals
// The EXPLICIT alpha approval set — exactly the spike-verified end state of setupTradingApprovals
// (poly-spike HANDOFF wallet-state table), nothing more: the SDK's generic prepareTradingApprovals
// grants MAX_UINT/approval-for-all to neg-risk adapters, routers and perps contracts too (S4
// review, Sol #6/K3 H2) — a blast radius the alpha never uses. Unlimited ERC-20 allowance to the
// two EXCHANGES is the documented deliberate exception to the exact-amount rule (plan §2.2; the
// exact-amount rule is for the wrap onramp).
import { PUSD_ADDRESS } from "./polygon";

export const CTF_EXCHANGE = "0xe111180000d2663c0091e4f400237545b87b996b"; // V2 CTF Exchange
export const NEGRISK_CTF_EXCHANGE = "0xe2222d279d744050d28e00520010520000310f59"; // NegRisk CTF Exchange
export const CONDITIONAL_TOKENS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const MAX_UINT256 = "f".repeat(64);

// approve(spender, MAX)   0x095ea7b3   |   setApprovalForAll(operator, true)   0xa22cb465
export function buildApprovalCalls(): WalletCall[] {
  const approvePusd = (spender: string) => ({ to: PUSD_ADDRESS, data: "0x095ea7b3" + addr(spender) + MAX_UINT256 });
  const approveCtf = (operator: string) => ({
    to: CONDITIONAL_TOKENS,
    data: "0xa22cb465" + addr(operator) + "1".padStart(64, "0"),
  });
  return [approvePusd(CTF_EXCHANGE), approvePusd(NEGRISK_CTF_EXCHANGE), approveCtf(CTF_EXCHANGE), approveCtf(NEGRISK_CTF_EXCHANGE)];
}
