// Seeker flavor — Mobile Wallet Adapter (raw protocol, no web3.js/kit on the device: MWA speaks
// base64 payloads, our server speaks base64 payloads, nothing to decode in between).
// Contract: ./wallet.flavor.d.ts.
import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
  transact,
  type AuthorizationResult,
  type MobileWallet,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import * as SecureStore from "expo-secure-store";
import type { MwaLinkNonceResponse, MwaLinkRequest } from "@contract/api-types";
import { API_BASE } from "../../lib/config";

export const available = true;

// Shown by the wallet on the authorize sheet. `uri` is what wallets verify the app against
// (Digital Asset Links on that domain) — it MUST be our site, not a scheme.
const IDENTITY = { name: "Hedge Fun", uri: API_BASE, icon: "favicon.ico" } as const;
const CHAIN = "solana:mainnet";

// SecureStore keys may contain only [A-Za-z0-9._-] — a ':' makes every write reject.
const CACHE_KEY = "hf_mwa_auth_v1";

// One grant per account the user has linked from this phone, keyed by the base58 address the server
// verified. `addressB64` is the same account as the wallet names it (Account.address), so a later
// authorization can be checked against the payer it is supposed to sign for. `pending` is the grant
// from the last connect(), waiting for the server's base58 to file it under (bindPayer).
type Grant = { token: string; addressB64: string };
type Cache = { grants: Record<string, Grant>; pending: Grant | null };

async function readCache(): Promise<Cache> {
  try {
    const raw = await SecureStore.getItemAsync(CACHE_KEY);
    const c = raw ? (JSON.parse(raw) as Partial<Cache>) : null;
    return { grants: c?.grants ?? {}, pending: c?.pending ?? null };
  } catch {
    return { grants: {}, pending: null };
  }
}
// A cache write that fails must never fail the authorization it records — the wallet already said
// yes; the only loss is one extra approve sheet next time.
async function writeCache(c: Cache): Promise<void> {
  await SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(c)).catch(() => undefined);
}

function firstAccount(r: AuthorizationResult): { token: string; addressB64: string } | null {
  const acct = r.accounts[0];
  return acct ? { token: r.auth_token, addressB64: acct.address } : null;
}

// authorize() with a cached auth_token re-uses the grant when the wallet still honours it. The MWA
// spec has the dapp DISCARD a token the wallet rejects and ask afresh — so an authorization failure
// with a token is retried once without it, and only a failure of that fresh request is the user's no.
async function authorizeWith(
  wallet: MobileWallet,
  grant: Grant | null,
  extra: { sign_in_payload?: MwaLinkNonceResponse } = {},
): Promise<AuthorizationResult> {
  if (grant) {
    try {
      return await wallet.authorize({ identity: IDENTITY, chain: CHAIN, auth_token: grant.token, addresses: [grant.addressB64], ...extra });
    } catch (e) {
      const rejectedToken =
        e instanceof SolanaMobileWalletAdapterProtocolError &&
        e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED;
      if (!rejectedToken) throw e;
    }
  }
  return wallet.authorize({ identity: IDENTITY, chain: CHAIN, ...extra });
}

export async function connect(siws: MwaLinkNonceResponse): Promise<MwaLinkRequest> {
  return transact(async (wallet) => {
    // A sign-in is a fresh grant on purpose (no cached token): the wallet must show the SIWS sheet.
    const r = await authorizeWith(wallet, null, { sign_in_payload: siws });
    const s = r.sign_in_result;
    if (!s) throw new Error("wallet_no_siws"); // wallet does not implement Sign In With Solana
    const grant = firstAccount(r);
    const cache = await readCache();
    await writeCache({ ...cache, pending: grant && grant.addressB64 === s.address ? grant : null });
    return { address: s.address, signed_message: s.signed_message, signature: s.signature };
  });
}

export async function bindPayer(address: string, addressB64: string): Promise<void> {
  const cache = await readCache();
  const token = cache.pending?.addressB64 === addressB64 ? cache.pending.token : cache.grants[address]?.token;
  if (!token) return; // nothing to file — the next signature asks the wallet afresh
  await writeCache({ grants: { ...cache.grants, [address]: { token, addressB64 } }, pending: null });
}

export async function signTransaction(txBase64: string, payer: string): Promise<string> {
  return transact(async (wallet) => {
    const cache = await readCache();
    const grant = cache.grants[payer] ?? null;
    const r = await authorizeWith(wallet, grant);
    const got = firstAccount(r);
    // The server built this swap for `payer`. A wallet that answers with another account cannot
    // sign it — say so before asking, instead of a signature the server would reject.
    if (grant && got && got.addressB64 !== grant.addressB64) throw new Error("wallet_account_mismatch");
    if (got) await writeCache({ ...cache, grants: { ...cache.grants, [payer]: { token: got.token, addressB64: got.addressB64 } } });
    const { signed_payloads } = await wallet.signTransactions({ payloads: [txBase64] });
    const signed = signed_payloads[0];
    if (!signed) throw new Error("wallet_not_signed");
    return signed;
  });
}

export async function disconnect(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHE_KEY).catch(() => undefined);
}

// The two outcomes a screen must tell apart from a real failure: the user backed out (the sheet
// was dismissed, authorization declined, nothing signed) and there is no wallet app at all.
export function isUserCancel(e: unknown): boolean {
  if (e instanceof SolanaMobileWalletAdapterError) {
    return (
      e.code === SolanaMobileWalletAdapterErrorCode.ERROR_ASSOCIATION_CANCELLED ||
      e.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED ||
      e.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_TIMEOUT
    );
  }
  if (e instanceof SolanaMobileWalletAdapterProtocolError) {
    return (
      e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED ||
      e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED
    );
  }
  return false;
}
export function isNoWallet(e: unknown): boolean {
  return e instanceof SolanaMobileWalletAdapterError && e.code === SolanaMobileWalletAdapterErrorCode.ERROR_WALLET_NOT_FOUND;
}

// Conformance to the port — a signature drift here is a tsc error, not a runtime surprise.
const _port: typeof import("./wallet.flavor") = { available, connect, bindPayer, signTransaction, disconnect, isUserCancel, isNoWallet };
void _port;
