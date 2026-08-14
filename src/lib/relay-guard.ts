// The device's own gate on relay payloads. "The server holds no keys" is true, but the server picks
// WHAT the device signs — so without this, a compromised or buggy server can hand the browser a
// deposit-wallet Batch whose calls approve an attacker, and one routine-looking prompt drains the
// wallet (found independently by both S9 reviewers). Pure and SDK-free so tsx can test it.
import { buildApprovalCalls, buildWrapCalls, CONDITIONAL_TOKENS, CTF_EXCHANGE, NEGRISK_CTF_EXCHANGE } from "./wallet-ops";

export type RelayKind = "APPROVALS" | "WRAP" | "REDEEM" | "WITHDRAW";

type RelayRequest = { kind?: unknown; payload?: unknown };
type RelayContext = { depositWallet: string; chainId?: number };
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
function firstAddressArg(data: string): string | null {
  const word = data.slice(10, 74);
  return /^[0-9a-fA-F]{64}$/.test(word) ? `0x${word.slice(24).toLowerCase()}` : null;
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
      const spender = firstAddressArg(String(call.data));
      if (!spender || !EXCHANGE_ALLOWLIST.includes(spender)) throw new Error(`spender_not_allowed: ${spender ?? "unreadable"}`);
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
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) {
    throw new Error("bad_call_shape: calls must be 1–8 entries");
  }
  raw.forEach(assertCallShape);
  const calls = raw as readonly CallRecord[];

  switch (kind) {
    case "APPROVALS":
      assertAgainst(calls, APPROVAL_ALLOWLIST, true);
      break;
    case "WRAP":
      assertAgainst(calls, WRAP_ALLOWLIST, false);
      break;
    case "REDEEM": {
      // Target only: the SDK builds the redeem calldata and we have not byte-pinned it, so pinning
      // a selector here would false-reject a valid redemption.
      const ctf = CONDITIONAL_TOKENS.toLowerCase();
      for (const call of calls) {
        if (String(call.target).toLowerCase() !== ctf) throw new Error(`target_not_allowed: ${String(call.target)}`);
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
