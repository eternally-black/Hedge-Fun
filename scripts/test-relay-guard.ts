// The device-side gate on relay payloads: what the browser refuses to sign even when our own server
// asks for it. Each case names the drain it prevents.
import assert from "node:assert/strict";
import { APPROVAL_ALLOWLIST, EXCHANGE_ALLOWLIST, WRAP_ALLOWLIST, assertRelayPayload } from "../src/lib/relay-guard";
import {
  buildApprovalCalls,
  buildPusdTransferCall,
  buildWrapCalls,
  COLLATERAL_ADAPTER,
  COLLATERAL_ONRAMP,
  CONDITIONAL_TOKENS,
  PUSD_ADDRESS,
} from "../src/lib/wallet-ops";

const DEPOSIT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const ctx = { depositWallet: DEPOSIT, chainId: 137 };

type CallInput = { target: string; data: string; value?: unknown };
const approvals = buildApprovalCalls();
const wraps = buildWrapCalls(DEPOSIT, 1_000_000n);
const asCalls = (list: { to: string; data: string }[]): CallInput[] => list.map((c) => ({ target: c.to, data: c.data }));
const word = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function payload(calls: readonly CallInput[], over: Record<string, unknown> = {}) {
  const base = {
    domain: { chainId: 137, verifyingContract: DEPOSIT },
    types: { Batch: [], Call: [] },
    primaryType: "Batch",
    message: { wallet: DEPOSIT, deadline: Math.floor(Date.now() / 1000) + 600, calls },
  };
  return {
    ...base,
    ...over,
    domain: { ...base.domain, ...((over.domain as object) ?? {}) },
    message: { ...base.message, ...((over.message as object) ?? {}) },
  };
}
const req = (p: unknown, kind: unknown = "signGaslessTypedData") => ({ kind, payload: p });

async function main() {
  // 1 — the eight calls the alpha actually makes must pass untouched, or the guard breaks the product.
  assert.strictEqual(APPROVAL_ALLOWLIST.length, 8); // 2 exchanges + 2 collateral adapters, each × pUSD and CTF
  assert.doesNotThrow(() => assertRelayPayload("APPROVALS", req(payload(asCalls(approvals))), ctx));

  // 2 — same for the wrap pair (approve + on-ramp), which is byte-pinned to a production transaction.
  assert.strictEqual(WRAP_ALLOWLIST.length, 2);
  assert.doesNotThrow(() => assertRelayPayload("WRAP", req(payload(asCalls(wraps))), ctx));

  // 3 — a bare hash cannot be inspected; signing it is signing whatever the server chose.
  assert.throws(() => assertRelayPayload("APPROVALS", req(payload([]), "signGaslessMessage"), ctx), /blind_hash_refused/);

  // 4 — a foreign struct (an order, a permit) must never ride in on a wallet workflow.
  assert.throws(() => assertRelayPayload("APPROVALS", req(payload([], { primaryType: "Order" })), ctx), /unexpected_primary_type/);

  // 5 — a payload for another chain is a cross-protocol replay dressed as a workflow step.
  assert.throws(() => assertRelayPayload("APPROVALS", req(payload([], { domain: { chainId: 1 } })), ctx), /wrong_chain/);

  // 6+7 — the batch must execute on THIS user's wallet: domain and message must both say so.
  assert.throws(
    () => assertRelayPayload("APPROVALS", req(payload([], { domain: { verifyingContract: OTHER } })), ctx),
    /wrong_wallet/,
  );
  assert.throws(() => assertRelayPayload("APPROVALS", req(payload([], { message: { wallet: OTHER } })), ctx), /wrong_wallet/);

  // 8 — an expired signature is replay bait; a far-future one is a standing authorization.
  const secs = Math.floor(Date.now() / 1000);
  assert.throws(() => assertRelayPayload("APPROVALS", req(payload([], { message: { deadline: secs - 301 } })), ctx), /bad_deadline/);
  assert.throws(() => assertRelayPayload("APPROVALS", req(payload([], { message: { deadline: secs + 7201 } })), ctx), /bad_deadline/);

  // 9 — a nonzero value would move native MATIC out of the wallet; our flows never send any.
  assert.throws(
    () => assertRelayPayload("APPROVALS", req(payload(asCalls(approvals).map((c) => ({ ...c, value: "1" })))), ctx),
    /nonzero_value/,
  );

  // 10 — an approval aimed at an attacker's own contract is not one of the eight.
  assert.throws(
    () => assertRelayPayload("APPROVALS", req(payload([{ target: ATTACKER, data: `0x095ea7b3${word(ATTACKER)}${"f".repeat(64)}` }])), ctx),
    /target_not_allowed/,
  );

  // 11 — THE drain case: a real pUSD approve, right target and selector, attacker in the spender arg.
  assert.ok(!EXCHANGE_ALLOWLIST.includes(ATTACKER.toLowerCase()));
  assert.throws(
    () =>
      assertRelayPayload(
        "APPROVALS",
        req(payload([{ target: approvals[0].to, data: `0x095ea7b3${word(ATTACKER)}${"f".repeat(64)}` }])),
        ctx,
      ),
    /spender_not_allowed/,
  );

  // 12 — REDEEM goes to the COLLATERAL ADAPTER, not to conditional-tokens: the SDK builds it as
  // ctfRedeemPositionsCall(adapterAddress, …). Pinning conditional-tokens (the guard's first rule)
  // refused every real redemption, so that exact regression is asserted here.
  assert.doesNotThrow(() => assertRelayPayload("REDEEM", req(payload([{ target: COLLATERAL_ADAPTER, data: "0x12345678" }])), ctx));
  assert.throws(
    () => assertRelayPayload("REDEEM", req(payload([{ target: CONDITIONAL_TOKENS, data: "0x12345678" }])), ctx),
    /target_not_allowed/,
  );
  assert.throws(
    () => assertRelayPayload("REDEEM", req(payload([{ target: ATTACKER, data: "0x12345678" }])), ctx),
    /target_not_allowed/,
  );

  // 13 — the accepted ceiling: a WITHDRAW target cannot be pinned client-side, so an unknown one
  // passes — but the structural floor still holds.
  const unknown = [{ target: ATTACKER, data: "0x12345678" }];
  assert.doesNotThrow(() => assertRelayPayload("WITHDRAW", req(payload(unknown)), ctx));
  assert.throws(() => assertRelayPayload("WITHDRAW", req(payload(unknown, { message: { wallet: OTHER } })), ctx), /wrong_wallet/);

  // 14 — BRIDGE_OUT: a pUSD transfer to the address our own server minted is the whole operation.
  const BRIDGE = "0x4444444444444444444444444444444444444444";
  const bridgeCtx = { ...ctx, expectedRecipient: BRIDGE };
  const good = buildPusdTransferCall(BRIDGE, 1_000_000n);
  assert.doesNotThrow(() =>
    assertRelayPayload("BRIDGE_OUT", req(payload([{ target: good.to, data: good.data }])), bridgeCtx),
  );

  // 15 — without an expected recipient there is nothing to verify against, so the device refuses
  // rather than trusting the server's word about where the money goes.
  assert.throws(
    () => assertRelayPayload("BRIDGE_OUT", req(payload([{ target: good.to, data: good.data }])), ctx),
    /recipient_unknown/,
  );

  // 16 — THE bridge attack: a legitimate-looking pUSD transfer whose destination was swapped.
  const redirected = buildPusdTransferCall(ATTACKER, 1_000_000n);
  assert.throws(
    () => assertRelayPayload("BRIDGE_OUT", req(payload([{ target: redirected.to, data: redirected.data }])), bridgeCtx),
    /recipient_not_allowed/,
  );

  // 17+18 — only pUSD, and only transfer(): anything else riding in a BRIDGE_OUT batch is refused.
  assert.throws(
    () => assertRelayPayload("BRIDGE_OUT", req(payload([{ target: COLLATERAL_ADAPTER, data: good.data }])), bridgeCtx),
    /target_not_allowed/,
  );
  assert.throws(
    () =>
      assertRelayPayload(
        "BRIDGE_OUT",
        req(payload([{ target: PUSD_ADDRESS, data: `0x12345678${word(BRIDGE)}${"f".repeat(64)}` }])),
        bridgeCtx,
      ),
    /selector_not_allowed/,
  );

  // 19+20 — THE wrap attack, the mirror of 16: both wrap calls pass the target+selector allowlist
  // no matter what ADDRESS they carry, because the allowlist is derived from a zero-address probe.
  // Unpinned, one routine "top up your balance" prompt either hands the attacker an allowance on the
  // wallet's USDC.e, or wraps the user's USDC.e straight into the attacker's pUSD.
  const stolenApproval = { target: wraps[0].to, data: `0x095ea7b3${word(ATTACKER)}${word("0xf4240")}` };
  assert.throws(
    () => assertRelayPayload("WRAP", req(payload([stolenApproval, ...asCalls([wraps[1]])])), ctx),
    /spender_not_allowed/,
  );
  const stolenWrap = asCalls(buildWrapCalls(ATTACKER, 1_000_000n))[1];
  assert.throws(
    () => assertRelayPayload("WRAP", req(payload([...asCalls([wraps[0]]), stolenWrap])), ctx),
    /recipient_not_allowed/,
  );

  // 21-23 — the bridge AMOUNT attack, the other half of 16: same approved destination, wrong number.
  // The recipient check cannot see word 1, and bridge-out's convergence ("balance dropped by at
  // least amount") is satisfied by a bigger debit too, so an unpinned amount meant a run approved
  // for $1 could sign away $100. Omitting the expectation must stay permissive — the cases above
  // pass no amount and must keep testing exactly what they tested before.
  const amountCtx = { ...bridgeCtx, expectedAmountMicro: "1000000" };
  assert.doesNotThrow(() =>
    assertRelayPayload("BRIDGE_OUT", req(payload([{ target: good.to, data: good.data }])), amountCtx),
  );
  const drain = buildPusdTransferCall(BRIDGE, 100_000_000n);
  assert.throws(
    () => assertRelayPayload("BRIDGE_OUT", req(payload([{ target: drain.to, data: drain.data }])), amountCtx),
    /amount_not_allowed/,
  );
  assert.doesNotThrow(
    () => assertRelayPayload("BRIDGE_OUT", req(payload([{ target: drain.to, data: drain.data }])), bridgeCtx),
    "no expectation supplied -> the amount is not pinned",
  );

  // 24 — the batch-multiplier: eight copies of the EXACT approved transfer. Every per-call check
  // (target, selector, recipient, amount) passes on each one, so only a count check catches it —
  // otherwise a $25 approval signs away $200.
  assert.throws(
    () =>
      assertRelayPayload(
        "BRIDGE_OUT",
        req(payload(Array.from({ length: 8 }, () => ({ target: good.to, data: good.data })))),
        amountCtx,
      ),
    /bad_call_shape/,
  );

  // 25 — the standing-allowance wrap: approve MAX_UINT, wrap one dollar. Target, selector, spender
  // and credited wallet are all the real ones, so every other WRAP check passes; only pinning the
  // two amounts to each other catches it. wallet-ops approves the EXACT amount precisely so no
  // allowance survives the batch.
  const wrapMax = { target: wraps[0].to, data: `0x095ea7b3${word(COLLATERAL_ONRAMP)}${"f".repeat(64)}` };
  assert.throws(
    () => assertRelayPayload("WRAP", req(payload([wrapMax, ...asCalls([wraps[1]])])), ctx),
    /amount_not_allowed/,
  );

  console.log("test-relay-guard: OK");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
