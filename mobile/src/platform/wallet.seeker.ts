// Seeker flavor — Mobile Wallet Adapter (raw protocol, no web3.js/kit on the device: MWA speaks
// base64 payloads, our server speaks base64 payloads, nothing to decode in between).
// Contract: ./wallet.flavor.d.ts.
import { transact, type AuthorizationResult, type MobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol";
import * as SecureStore from "expo-secure-store";
import type { MwaLinkNonceResponse, MwaLinkRequest } from "@contract/api-types";
import { API_BASE } from "../../lib/config";

export const available = true;

// Shown by the wallet on the authorize sheet. `uri` is what wallets verify the app against
// (Digital Asset Links on that domain) — it MUST be our site, not a scheme.
const IDENTITY = { name: "Hedge Fun", uri: API_BASE, icon: "favicon.ico" } as const;
const CHAIN = "solana:mainnet";
const AUTH_KEY = "hf_mwa_auth:v1"; // { token, address(base64) } — lets the next session skip the approve sheet

type Cached = { token: string; address: string };
async function readCached(): Promise<Cached | null> {
  try {
    const raw = await SecureStore.getItemAsync(AUTH_KEY);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}
async function remember(r: AuthorizationResult): Promise<void> {
  const acct = r.accounts[0];
  if (!acct) return;
  await SecureStore.setItemAsync(AUTH_KEY, JSON.stringify({ token: r.auth_token, address: acct.address } satisfies Cached));
}

// authorize() with a cached auth_token re-uses the grant when the wallet still honours it and
// falls back to a fresh approval when it does not — one call covers both (MWA 2.0 folded
// reauthorize into authorize).
async function authorize(wallet: MobileWallet, extra: { sign_in_payload?: MwaLinkNonceResponse } = {}): Promise<AuthorizationResult> {
  const cached = await readCached();
  const r = await wallet.authorize({
    identity: IDENTITY,
    chain: CHAIN,
    ...(cached && !extra.sign_in_payload ? { auth_token: cached.token } : {}),
    ...extra,
  });
  await remember(r);
  return r;
}

export async function connect(siws: MwaLinkNonceResponse): Promise<MwaLinkRequest> {
  return transact(async (wallet) => {
    const r = await authorize(wallet, { sign_in_payload: siws });
    const s = r.sign_in_result;
    if (!s) throw new Error("wallet_no_siws"); // wallet does not implement Sign In With Solana
    return { address: s.address, signed_message: s.signed_message, signature: s.signature };
  });
}

export async function signTransaction(txBase64: string): Promise<string> {
  return transact(async (wallet) => {
    await authorize(wallet);
    const { signed_payloads } = await wallet.signTransactions({ payloads: [txBase64] });
    const signed = signed_payloads[0];
    if (!signed) throw new Error("wallet_not_signed");
    return signed;
  });
}

export async function disconnect(): Promise<void> {
  await SecureStore.deleteItemAsync(AUTH_KEY).catch(() => undefined);
}

// Conformance to the port — a signature drift here is a tsc error, not a runtime surprise.
const _port: typeof import("./wallet.flavor") = { available, connect, signTransaction, disconnect };
void _port;
