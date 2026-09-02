// The device's own gate on relay payloads. "The server holds no keys" is true, but the server picks
// WHAT the device signs — so without this, a compromised or buggy server can hand the browser a
// deposit-wallet Batch whose calls approve an attacker, and one routine-looking prompt drains the
// wallet (found independently by both S9 reviewers). Pure and SDK-free so tsx can test it.
import {
  buildApprovalCalls,
  buildWrapCalls,
  COLLATERAL_ADAPTER,
  COLLATERAL_ONRAMP,
  CTF_EXCHANGE,
  NEGRISK_CTF_EXCHANGE,
  NEG_RISK_COLLATERAL_ADAPTER,
  PUSD_ADDRESS,
} from "./wallet-ops";

export type RelayKind = "APPROVALS" | "WRAP" | "REDEEM" | "WITHDRAW" | "BRIDGE_OUT";

type RelayRequest = { kind?: unknown; payload?: unknown };
type RelayContext = {
  depositWallet: string;
  chainId?: number;
  expectedRecipient?: string;
  expectedAmountMicro?: string; // BRIDGE_OUT: how much the user approved, not just where it goes
};
type CallRecord = Record<string, unknown>;

export type TargetSelectorRule = { target: string; selector: string };
export type ApprovalRule = TargetSelectorRule & { spender: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function asObject(value: unknown, refusal: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(refusal);
  return value;
}

function address(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
}

// Relay payloads arrive through our own safeJson, so a numeric can be a bigint, a number, a decimal
// string, or the "123n" wire form.
function numeric(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string") {
    const s = value.trim().replace(/n$/, "");
    if (/^-?\d+$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  }
  return null;
}

// ERC-20 approve(spender,…) and ERC-1155 setApprovalForAll(operator,…) both carry the address we
// care about in the FIRST word — a target/selector check alone still lets a forged payload approve
// an attacker, so the argument itself is decoded.
function firstAddressArg(data: string, index = 0): string | null {
  const word = data.slice(10 + index * 64, 74 + index * 64);
  return /^[0-9a-fA-F]{64}$/.test(word) ? `0x${word.slice(24).toLowerCase()}` : null;
}

// The same word, read as a uint — amounts live next to the addresses in every call this guard pins.
function uintArg(data: string, index: number): bigint | null {
  const word = data.slice(10 + index * 64, 74 + index * 64);
  return /^[0-9a-fA-F]{64}$/.test(word) ? BigInt(`0x${word}`) : null;
}

const rule = (call: { to: string; data: string }): TargetSelectorRule => ({
  target: call.to.toLowerCase(),
  selector: call.data.slice(0, 10).toLowerCase(),
});

// Derived from the very builders the server uses, so the allowlist cannot drift from the calls the
// alpha actually makes — and no address is typed twice.
export const WRAP_ALLOWLIST: readonly TargetSelectorRule[] = buildWrapCalls(
  "0x0000000000000000000000000000000000000000",
  1n,
).map(rule);

export const EXCHANGE_ALLOWLIST: readonly string[] = [CTF_EXCHANGE.toLowerCase(), NEGRISK_CTF_EXCHANGE.toLowerCase()];

export const APPROVAL_ALLOWLIST: readonly ApprovalRule[] = buildApprovalCalls().map((call) => {
  const spender = firstAddressArg(call.data);
  if (!spender) throw new Error("wallet-ops approval calldata is malformed");
  return { ...rule(call), spender };
});

function assertCallShape(raw: unknown, index: number): void {
  if (!isObject(raw)) throw new Error(`bad_call_shape: call ${index} is not an object`);
  if (!address(raw.target)) throw new Error(`bad_call_shape: call ${index} target is not an address`);
  const data = raw.data;
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) {
    throw new Error(`bad_call_shape: call ${index} data is not even-length hex with a 4-byte selector`);
  }
  // Our flows never send native MATIC; a nonzero value is someone else's transaction.
  const value = numeric(raw.value ?? 0n);
  if (value === null || value !== 0n) throw new Error(`nonzero_value: call ${index}`);
}

function assertAgainst(calls: readonly CallRecord[], allowed: readonly TargetSelectorRule[], checkSpender: boolean) {
  for (const call of calls) {
    const target = String(call.target).toLowerCase();
    const selector = String(call.data).slice(0, 10).toLowerCase();
    const match = allowed.find((a) => a.target === target && a.selector === selector);
    if (!match) {
      if (!allowed.some((a) => a.target === target)) throw new Error(`target_not_allowed: ${target}`);
      throw new Error(`selector_not_allowed: ${selector}`);
    }
    if (checkSpender) {
      // The spender set is DERIVED from our own approval calls, so the check is the full triple
      // (target, selector, spender) and it cannot drift when the approval set grows.
      const spender = firstAddressArg(String(call.data));
      const granted = APPROVAL_ALLOWLIST.some(
        (a) => a.target === target && a.selector === selector && a.spender === spender,
      );
      if (!spender || !granted) throw new Error(`spender_not_allowed: ${spender ?? "unreadable"}`);
    }
  }
}

export function assertRelayPayload(kind: RelayKind, request: RelayRequest, ctx: RelayContext): void {
  // The message path signs an opaque 32-byte hash — nothing about it is checkable here, and it
  // belongs to the proxy/Safe wallet flows we never take. Refusing beats prompting blind.
  if (request.kind === "signGaslessMessage") {
    throw new Error("blind_hash_refused: deposit wallets sign typed Batch data, never a bare hash");
  }
  if (request.kind !== "signGaslessTypedData") throw new Error(`unknown_request_kind: ${String(request.kind)}`);

  const payload = asObject(request.payload, "unexpected_primary_type: payload is not an object");
  if (payload.primaryType !== "Batch") {
    throw new Error(`unexpected_primary_type: expected Batch, got ${String(payload.primaryType)}`);
  }
  const types = asObject(payload.types, "unexpected_primary_type: missing types");
  if (!Array.isArray(types.Batch) || !Array.isArray(types.Call)) {
    throw new Error("unexpected_primary_type: Batch/Call declarations are required");
  }

  // Pinning the chain is what stops a foreign struct (a Permit2, another venue's order) arriving
  // dressed as "step 2 of your withdrawal".
  const domain = asObject(payload.domain, "wrong_chain: missing domain");
  const expected = BigInt(ctx.chainId ?? 137);
  if (numeric(domain.chainId) !== expected) throw new Error(`wrong_chain: ${String(domain.chainId)}`);

  const wallet = ctx.depositWallet.toLowerCase();
  if (address(domain.verifyingContract) !== wallet) {
    throw new Error(`wrong_wallet: verifyingContract ${String(domain.verifyingContract)}`);
  }
  const message = asObject(payload.message, "wrong_wallet: missing message");
  if (address(message.wallet) !== wallet) throw new Error(`wrong_wallet: message.wallet ${String(message.wallet)}`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = numeric(message.deadline); // seconds; the SDK sets now + 600
  if (deadline === null || deadline < now - 300n || deadline > now + 7200n) {
    throw new Error("bad_deadline: outside [now − 5min, now + 2h]");
  }

  const raw = message.calls;
  // The ceiling is "our largest legitimate batch", not a round number: it exists so a server cannot
  // bury an extra call in a long list the user will never read. That batch is the activation set —
  // it grew from eight to nine when the auto-redeem operator joined it, and this bound has to move
  // with it or the device refuses the very batch the product asks people to sign. Every call is
  // checked individually below; the length only bounds what a person is asked to trust at once.
  const MAX_CALLS = 9;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CALLS) {
    throw new Error(`bad_call_shape: calls must be 1–${MAX_CALLS} entries`);
  }
  raw.forEach(assertCallShape);
  const calls = raw as readonly CallRecord[];

  switch (kind) {
    case "APPROVALS":
      assertAgainst(calls, APPROVAL_ALLOWLIST, true);
      break;
    case "WRAP": {
      assertAgainst(calls, WRAP_ALLOWLIST, false);
      // Target+selector alone is NOT enough here, and this arm used to stop there: both wrap calls
      // carry an address ARGUMENT the allowlist never reads. Unpinned, a forged WRAP passes the
      // identical shape while approving an attacker as spender of the wallet's USDC.e, or wrapping
      // the user's USDC.e into somebody else's pUSD. The APPROVALS arm already pins its spender —
      // this is that same check for the two arguments the wrap recipe actually carries.
      let approved: bigint | null = null;
      let wrapped: bigint | null = null;
      for (const call of calls) {
        const data = String(call.data);
        const selector = data.slice(0, 10).toLowerCase();
        if (selector === "0x095ea7b3") {
          const spender = firstAddressArg(data);
          if (spender !== COLLATERAL_ONRAMP.toLowerCase()) {
            throw new Error(`spender_not_allowed: ${spender ?? "unreadable"}`);
          }
          approved = uintArg(data, 1); // approve(spender, amount)
        } else {
          // wrap(token, wallet, amount): the credited wallet is the SECOND word, and it is the only
          // thing standing between "wrap my own USDC.e" and "mint pUSD to the attacker".
          const credited = firstAddressArg(data, 1);
          if (credited !== wallet) throw new Error(`recipient_not_allowed: ${credited ?? "unreadable"}`);
          wrapped = uintArg(data, 2); // wrap(token, wallet, amount)
        }
      }
      // The allowance must be spent by the wrap it pays for, exactly. wallet-ops states the rule the
      // recipe was built on — "Approving the EXACT amount (never max) is deliberate — no standing
      // allowance, same as the frontend" — and target/selector/spender checks cannot see it: a batch
      // approving MAX_UINT while wrapping a dollar passes all of them and leaves the on-ramp with a
      // permanent claim on the wallet's USDC.e. Equality is checkable from the payload alone, which
      // is what makes it worth having here.
      // CEILING: this pins the two amounts to EACH OTHER, not to the user's intent. The device has
      // no RPC of its own, so it cannot know the wallet's true USDC.e balance, and an expected value
      // taken from the same server that built the payload would only catch a buggy one. A server
      // that wraps more of the user's own USDC.e than the funding attempt observed is still possible
      // — the funds stay in the user's own wallet as pUSD, which is why this is the drawn line.
      if (approved === null || wrapped === null) throw new Error("bad_call_shape: WRAP needs approve + wrap");
      if (approved !== wrapped) throw new Error(`amount_not_allowed: approve ${approved} != wrap ${wrapped}`);
      break;
    }
    case "REDEEM": {
      // Target only, and NOT the conditional-tokens contract: the SDK builds redemption as
      // ctfRedeemPositionsCall(adapterAddress, …) where the adapter is the normal-market or the
      // neg-risk collateral adapter. Pinning conditional-tokens here (as this guard first did)
      // refuses every legitimate redemption. The selector stays unpinned — the SDK's redeem
      // calldata is not byte-pinned, and a guessed selector would false-reject a valid one. The
      // neg-risk adapter is allowed as a TARGET although the alpha does not approve it, so such an
      // attempt fails on chain with the real reason instead of on a misleading local refusal.
      const redeemTargets = [COLLATERAL_ADAPTER.toLowerCase(), NEG_RISK_COLLATERAL_ADAPTER.toLowerCase()];
      for (const call of calls) {
        const target = String(call.target).toLowerCase();
        if (!redeemTargets.includes(target)) throw new Error(`target_not_allowed: ${target}`);
      }
      break;
    }
    case "BRIDGE_OUT": {
      // This is the arm that CLOSES the ceiling the WITHDRAW case still documents: a bridge
      // recipient is knowable because our own server created it, unlike a router plan. The bridge
      // address is single-purpose, so the device can demand an exact pUSD transfer to exactly it.
      const recipient = address(ctx.expectedRecipient);
      if (!recipient) throw new Error("recipient_unknown: no bridge address to verify against");
      const expected = ctx.expectedAmountMicro === undefined ? null : numeric(ctx.expectedAmountMicro);
      if (ctx.expectedAmountMicro !== undefined && expected === null) {
        throw new Error(`amount_unreadable: ${String(ctx.expectedAmountMicro)}`);
      }
      // EXACTLY one transfer. Pinning target, selector, recipient and amount PER CALL is not enough
      // on its own: the shape check above admits up to MAX_CALLS calls, so nine copies of the very
      // transfer the user approved each pass every per-call test and the Batch debits 9× the approved
      // amount. bridgeOutSpec builds a single call, so anything else is not our plan.
      if (calls.length !== 1) throw new Error(`bad_call_shape: BRIDGE_OUT is one transfer, got ${calls.length}`);
      for (const call of calls) {
        const target = String(call.target).toLowerCase();
        if (target !== PUSD_ADDRESS.toLowerCase()) throw new Error(`target_not_allowed: ${target}`);
        const selector = String(call.data).slice(0, 10).toLowerCase();
        if (selector !== "0xa9059cbb") throw new Error(`selector_not_allowed: ${selector}`);
        const decoded = firstAddressArg(String(call.data));
        if (!decoded || decoded !== recipient) throw new Error(`recipient_not_allowed: ${decoded ?? "unreadable"}`);
        // WHERE was pinned above; this pins HOW MUCH. transfer(to, amount) carries the recipient in
        // word 0 and the amount in word 1, and the guard used to stop at word 0 — so a run approved
        // for $25 of a $100 balance could be handed transfer(bridge, 100e6) and the device would
        // sign it. Convergence cannot catch that either: bridge-out's verify is "balance dropped by
        // at LEAST amount", which a bigger debit satisfies too. Skipped when the caller supplies no
        // expectation, so the recipient-only contexts in the tests keep meaning what they meant.
        if (expected !== null) {
          const word1 = String(call.data).slice(74, 138);
          const amount = /^[0-9a-fA-F]{64}$/.test(word1) ? BigInt(`0x${word1}`) : null;
          if (amount !== expected) throw new Error(`amount_not_allowed: ${amount ?? "unreadable"}`);
        }
      }
      break;
    }
    case "WITHDRAW":
      // CEILING: the collateral-return plan comes from the SDK's router, whose target set is not
      // knowable client-side, so this arm gets structural checks only — it cannot catch an
      // attacker-chosen target inside a WITHDRAW batch. The fix is pinning the plan's targets
      // server-side once the withdrawal destination is decided at Gate-0.
      break;
  }
}
