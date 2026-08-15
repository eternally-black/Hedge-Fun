// DB-free self-check for the redeem candidate classifier (src/lib/redeem.ts) — the money decision
// behind the REDEEM workflow: what binds a run, what is booked as a loss without one, and what
// needs a human. Run: npx tsx scripts/test-redeem.ts
import assert from "node:assert";
import { planRedeem, type RedeemCandidate } from "../src/lib/redeem";

const cand = (over: Partial<RedeemCandidate> & { id: string }): RedeemCandidate => ({
  side: "YES",
  filledSharesMicro: 100n,
  closedSharesMicro: 0n,
  market: { status: "RESOLVED", resolvedOutcome: "YES", negRisk: false },
  ...over,
});
const lost = (id: string) =>
  cand({ id, side: "NO", market: { status: "RESOLVED", resolvedOutcome: "YES", negRisk: false } });

// 1. Nothing in, nothing out.
{
  const plan = planRedeem([]);
  assert.strictEqual(plan.bind, null);
  assert.deepStrictEqual(plan.losses, []);
}

// 2. A consumed position (filled === closed) is invisible to every arm.
{
  const plan = planRedeem([cand({ id: "c1", filledSharesMicro: 100n, closedSharesMicro: 100n })]);
  assert.strictEqual(plan.bind, null, "consumed position never binds");
  assert.strictEqual(plan.losses.length, 0, "and is not classified at all");
}

// 3. A loss is booked, never bound — redeeming it would move no money.
{
  const plan = planRedeem([lost("l1")]);
  assert.strictEqual(plan.bind, null, "a loss never binds a run");
  assert.deepStrictEqual(plan.losses.map((l) => l.id), ["l1"]);
}

// 4. CANCELED is a PUSH: it binds even with a null resolvedOutcome (collateral returns).
{
  const plan = planRedeem([cand({ id: "p1", market: { status: "CANCELED", resolvedOutcome: null, negRisk: false } })]);
  assert.strictEqual(plan.bind?.id, "p1", "a canceled market pushes and redeems");
  assert.strictEqual(plan.losses.length, 0, "a push is not a loss");
}

// 5. A neg-risk winner binds like any other: the alpha approval set grants the neg-risk collateral
// adapter now, so diverting it would strand a real win in a manual ops path for nothing.
{
  const plan = planRedeem([cand({ id: "n1", market: { status: "RESOLVED", resolvedOutcome: "YES", negRisk: true } })]);
  assert.strictEqual(plan.bind?.id, "n1", "neg-risk winner binds");
  assert.strictEqual(plan.losses.length, 0, "a winner is never a loss");
}

// 6. Order matters: the FIRST eligible winner binds whatever its market kind, and the losses behind
// it are still collected — a newest-first window must not skip an earlier winner.
{
  const plan = planRedeem([
    cand({ id: "n1", market: { status: "RESOLVED", resolvedOutcome: "YES", negRisk: true } }),
    lost("l1"),
    cand({ id: "w1" }),
    cand({ id: "w2" }),
  ]);
  assert.strictEqual(plan.bind?.id, "n1", "the neg-risk winner is first, so it binds");
  assert.deepStrictEqual(plan.losses.map((l) => l.id), ["l1"]);
}

// 7. Losses BEHIND the bound winner are still collected — the walk classifies the whole window.
{
  const plan = planRedeem([cand({ id: "w1" }), lost("l2")]);
  assert.strictEqual(plan.bind?.id, "w1");
  assert.deepStrictEqual(plan.losses.map((l) => l.id), ["l2"], "a loss after the bind is still booked");
}

console.log("OK: redeem plan — losses booked without a run, first winner binds (neg-risk included)");
console.log("PASS: redeem");
