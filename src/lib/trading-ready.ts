// Trading readiness — one source of truth for whether a Deposit Wallet can actually place orders.
// A freshly created wallet holds funds perfectly well and still cannot trade: the CLOB refuses
// every order with "not enough balance / allowance: the allowance is not enough -> spender:
// 0xE111…, allowance: 0". The grants are a one-time setup the user signs. Nothing on our side used
// to KNOW whether a wallet had them, so the first swipe learned it from a raw 400 out of the
// exchange, after a device signature and a claimed market slot. This module is that knowledge.
import { erc20Allowance, erc1155IsApprovedForAll, PUSD_ADDRESS } from "./polygon";
import {
  CTF_EXCHANGE,
  NEGRISK_CTF_EXCHANGE,
  COLLATERAL_ADAPTER,
  NEG_RISK_COLLATERAL_ADAPTER,
  AUTO_REDEEM_OPERATOR,
  CONDITIONAL_TOKENS,
} from "./wallet-ops";

// The approval batch (buildApprovalCalls) and this table MUST stay in lockstep — a check that
// covers less than the batch grants would call a half-approved wallet ready, and one that covers
// more would demand a grant nothing ever makes. scripts/test-wallet-ops.ts compares the two.
export interface RequiredApproval {
  label: string;
  kind: "erc20" | "erc1155";
  token: string; // pUSD for erc20, the conditional-token contract for erc1155
  target: string; // spender (erc20) or operator (erc1155)
}

export const REQUIRED_APPROVALS: readonly RequiredApproval[] = [
  // pUSD is the only collateral the CLOB counts, and each of these contracts moves it on the
  // user's behalf: the exchanges to fill an order, the adapters to pay a redemption out.
  { label: "spend collateral on the CTF exchange", kind: "erc20", token: PUSD_ADDRESS, target: CTF_EXCHANGE },
  {
    label: "spend collateral on the neg-risk exchange",
    kind: "erc20",
    token: PUSD_ADDRESS,
    target: NEGRISK_CTF_EXCHANGE,
  },
  { label: "settle normal-market wins", kind: "erc20", token: PUSD_ADDRESS, target: COLLATERAL_ADAPTER },
  { label: "settle neg-risk wins", kind: "erc20", token: PUSD_ADDRESS, target: NEG_RISK_COLLATERAL_ADAPTER },

  // The other direction: moving the POSITION. A sell hands shares to the exchange, a redemption
  // burns them at the adapter — neither is possible without operator rights on the token.
  { label: "sell positions on the CTF exchange", kind: "erc1155", token: CONDITIONAL_TOKENS, target: CTF_EXCHANGE },
  {
    label: "sell positions on the neg-risk exchange",
    kind: "erc1155",
    token: CONDITIONAL_TOKENS,
    target: NEGRISK_CTF_EXCHANGE,
  },
  {
    label: "redeem normal-market positions",
    kind: "erc1155",
    token: CONDITIONAL_TOKENS,
    target: COLLATERAL_ADAPTER,
  },
  {
    label: "redeem neg-risk positions",
    kind: "erc1155",
    token: CONDITIONAL_TOKENS,
    target: NEG_RISK_COLLATERAL_ADAPTER,
  },
  // The one the user actually feels: with it, a market that resolves in their favour pays out by
  // itself. Without it the win sits as an unredeemed position until somebody signs a redemption.
  {
    label: "return winnings automatically",
    kind: "erc1155",
    token: CONDITIONAL_TOKENS,
    target: AUTO_REDEEM_OPERATOR,
  },
];

export interface TradingReadiness {
  ready: boolean;
  missing: string[]; // the labels of whatever is not granted
}

// We grant MAX_UINT256, so a genuine grant sits astronomically above this. The floor exists so a
// dust allowance — a partial or hand-made approval — can never read as "approved" (Sol S4 #5).
const ERC20_ALLOWANCE_FLOOR = 10n ** 15n; // $1B in micro-USD

export async function readTradingApprovals(wallet: string): Promise<TradingReadiness> {
  const results = await Promise.all(
    REQUIRED_APPROVALS.map(async (approval): Promise<boolean> => {
      try {
        if (approval.kind === "erc20") {
          return (await erc20Allowance(approval.token, wallet, approval.target)) >= ERC20_ALLOWANCE_FLOOR;
        }
        return await erc1155IsApprovedForAll(approval.token, wallet, approval.target);
      } catch {
        // A read that fails is NOT a grant. Erring toward "not ready" costs at worst one extra
        // approval run, which is idempotent and free; erring the other way spends a device
        // signature on an order the exchange was always going to refuse.
        return false;
      }
    }),
  );

  const missing = REQUIRED_APPROVALS.filter((_, i) => !results[i]).map((a) => a.label);
  return { ready: missing.length === 0, missing };
}

// Nine eth_calls belong nowhere near every swipe, so the verdict is cached in process (one app
// container per compose — the topology K3 verified).
const READY_TTL_MS = 10 * 60_000;
const NOT_READY_TTL_MS = 20_000;
const cache = new Map<string, { verdict: TradingReadiness; expiresAt: number }>();

export async function isTradingReady(wallet: string, opts?: { force?: boolean }): Promise<TradingReadiness> {
  const key = wallet.toLowerCase();
  const now = Date.now();
  if (!opts?.force) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.verdict;
  }
  const verdict = await readTradingApprovals(wallet);
  // The asymmetry is deliberate. A ready wallet does not spontaneously become unready — only an
  // explicit revocation does that, and the exchange's own refusal is the backstop. A NOT-ready one
  // is expected to change within seconds: the user is mid-activation and the screen is polling, so
  // a long TTL there would keep showing a blocker over a wallet that is already good.
  cache.set(key, { verdict, expiresAt: now + (verdict.ready ? READY_TTL_MS : NOT_READY_TTL_MS) });
  return verdict;
}

export function _resetTradingReadyCacheForTests(): void {
  cache.clear();
}
