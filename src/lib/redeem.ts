// Redeem candidate classification — pure, SDK-free, DB-free. Extracted from the REDEEM branch of
// src/app/api/real/workflow/route.ts so the money decision can be tested at all: that route
// imports @polymarket/client, which the tsx test resolver cannot load. The caller passes rows
// that structurally match Prisma's — no import needed in either direction.
export interface RedeemCandidate {
  id: string;
  side: string; // "YES" | "NO"
  filledSharesMicro: bigint | null;
  closedSharesMicro: bigint | null;
  market: { status: string; resolvedOutcome: string | null; negRisk: boolean | null };
}

export interface RedeemPlan {
  bind: RedeemCandidate | null; // the position to actually redeem (a winner, non-neg-risk)
  losses: RedeemCandidate[]; // lost positions to book + consume WITHOUT any run
  negRisk: RedeemCandidate[]; // winners this workflow cannot redeem — the adapter is not approved
}

export function planRedeem(candidates: RedeemCandidate[]): RedeemPlan {
  const plan: RedeemPlan = { bind: null, losses: [], negRisk: [] };
  // The whole window is classified even after a bind is found: the losses behind the bound winner
  // still need booking, and ops still needs to hear about neg-risk positions.
  for (const c of candidates) {
    if ((c.filledSharesMicro ?? 0n) - (c.closedSharesMicro ?? 0n) <= 0n) continue; // already consumed
    // CANCELED = push: the collateral returns, so it converges like a win.
    const won = c.market.status === "CANCELED" || c.side === c.market.resolvedOutcome;
    if (!won) {
      // A lost position redeems to ZERO collateral — a run would spend a device prompt and a
      // relayer submission to move no money (pre-Gate-0 item 6).
      plan.losses.push(c);
      continue;
    }
    if (c.market.negRisk === true) {
      // Neg-risk redemption routes through the NegRisk Adapter, which the explicit alpha approval
      // set does not grant (item 5) — binding it would ask for a signature that cannot land.
      plan.negRisk.push(c);
      continue;
    }
    if (!plan.bind) plan.bind = c; // first eligible winner, newest-first order preserved
  }
  return plan;
}
