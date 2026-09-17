// Play flavor — no wallet. The Play build renders the paper economy only (Google Play policy,
// docs/shipaton.md §1); screens read `available` and never show a real-money surface, so the
// functions below are unreachable by design and exist only to satisfy the port.
// Contract: ./wallet.flavor.d.ts.
import type { MwaLinkNonceResponse, MwaLinkRequest } from "@contract/api-types";

export const available = false;

export async function connect(_siws: MwaLinkNonceResponse): Promise<MwaLinkRequest> {
  throw new Error("wallet_unavailable");
}

export async function bindPayer(_address: string, _addressB64: string): Promise<void> {}

export async function signTransaction(_txBase64: string, _payer: string): Promise<string> {
  throw new Error("wallet_unavailable");
}

export async function disconnect(): Promise<void> {}

export function isUserCancel(_e: unknown): boolean {
  return false;
}
export function isNoWallet(_e: unknown): boolean {
  return false;
}

const _port: typeof import("./wallet.flavor") = { available, connect, bindPayer, signTransaction, disconnect, isUserCancel, isNoWallet };
void _port;
