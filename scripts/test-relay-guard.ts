// The device-side gate on relay payloads: what the browser refuses to sign even when our own server
// asks for it. Each case names the drain it prevents.
import assert from "node:assert/strict";
import { APPROVAL_ALLOWLIST, EXCHANGE_ALLOWLIST, WRAP_ALLOWLIST, assertRelayPayload } from "../src/lib/relay-guard";
import { buildApprovalCalls, buildWrapCalls, CONDITIONAL_TOKENS } from "../src/lib/wallet-ops";

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
  // 1 — the four calls the alpha actually makes must pass untouched, or the guard breaks the product.
  assert.strictEqual(APPROVAL_ALLOWLIST.length, 4);
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

  // 10 — an approval aimed at an attacker's own contract is not one of the four.
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

  // 12 — REDEEM is pinned to the conditional-tokens contract; its selector deliberately is not.
  assert.doesNotThrow(() => assertRelayPayload("REDEEM", req(payload([{ target: CONDITIONAL_TOKENS, data: "0x12345678" }])), ctx));
  assert.throws(
    () => assertRelayPayload("REDEEM", req(payload([{ target: ATTACKER, data: "0x12345678" }])), ctx),
    /target_not_allowed/,
  );

  // 13 — the accepted ceiling: a WITHDRAW target cannot be pinned client-side, so an unknown one
  // passes — but the structural floor still holds.
  const unknown = [{ target: ATTACKER, data: "0x12345678" }];
  assert.doesNotThrow(() => assertRelayPayload("WITHDRAW", req(payload(unknown)), ctx));
  assert.throws(() => assertRelayPayload("WITHDRAW", req(payload(unknown, { message: { wallet: OTHER } })), ctx), /wrong_wallet/);

  console.log("test-relay-guard: OK");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
