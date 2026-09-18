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

// One grant per account the user has linked FROM THIS PHONE, keyed by the base58 address the server
// verified. `addressB64` is the same account as the wallet names it (Account.address); `walletUriBase`
// is the wallet endpoint that issued the grant, so the next session opens the same wallet app.
// `pending` is the grant from the last connect(), waiting for the server's base58 (bindPayer).
// The mapping payer → account is written ONLY by bindPayer (after the server verified the SIWS
// proof) — never guessed from whatever account a later authorization happens to return.
type Grant = { token: string; addressB64: string; walletUriBase?: string };
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

const isTokenRejected = (e: unknown) =>
  e instanceof SolanaMobileWalletAdapterProtocolError &&
  e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED;

export async function connect(siws: MwaLinkNonceResponse): Promise<MwaLinkRequest> {
  return transact(async (wallet) => {
    // A sign-in is a fresh grant on purpose (no cached token): the wallet must show the SIWS sheet.
    const r = await wallet.authorize({ identity: IDENTITY, chain: CHAIN, sign_in_payload: siws });
    const s = r.sign_in_result;
    if (!s) throw new Error("wallet_no_siws"); // wallet does not implement Sign In With Solana
    // The signing account may sit anywhere in `accounts`; the grant is filed for THAT account.
    const acct = r.accounts.find((a) => a.address === s.address);
    const cache = await readCache();
    await writeCache({
      ...cache,
      pending: acct ? { token: r.auth_token, addressB64: acct.address, walletUriBase: r.wallet_uri_base } : null,
    });
    return { address: s.address, signed_message: s.signed_message, signature: s.signature };
  });
}

export async function bindPayer(address: string, addressB64: string): Promise<void> {
  const cache = await readCache();
  const p = cache.pending;
  const grant: Grant | undefined =
    p && p.addressB64 === addressB64 ? p : cache.grants[address]?.addressB64 === addressB64 ? cache.grants[address] : undefined;
  if (!grant) return; // nothing to file — the next signature asks the wallet afresh
  await writeCache({ grants: { ...cache.grants, [address]: grant }, pending: null });
}

export async function signTransaction(txBase64: string, payer: string): Promise<string> {
  const cache = await readCache();
  const grant = cache.grants[payer] ?? null;
  // Which wallet account must sign. Known when this payer was linked from this phone; unknown when it
  // was verified elsewhere (web/Phantom) — then nothing is cached and the wallet's own key check plus
  // the server's signature verification are what protect the funds.
  const expected = grant?.addressB64 ?? null;
  const hint = expected ? { addresses: [expected] } : {};

  return transact(
    async (wallet) => {
      let r: AuthorizationResult;
      try {
        r = await wallet.authorize({ identity: IDENTITY, chain: CHAIN, ...(grant ? { auth_token: grant.token } : {}), ...hint });
      } catch (e) {
        if (!grant || !isTokenRejected(e)) throw e;
        // The wallet no longer honours this grant: forget it FIRST (MWA spec), then ask afresh for the
        // same account. A failure of this fresh request is the user's own no.
        const { [payer]: _dropped, ...rest } = cache.grants;
        void _dropped;
        await writeCache({ ...cache, grants: rest });
        r = await wallet.authorize({ identity: IDENTITY, chain: CHAIN, ...hint });
      }
      if (expected) {
        // The server built this swap for `payer`. The authorized set must contain that account —
        // anywhere in the list, not just first — or the signature would be another account's.
        if (!r.accounts.some((a) => a.address === expected)) throw new Error("wallet_account_mismatch");
        await writeCache({
          ...(await readCache()),
          grants: { ...cache.grants, [payer]: { token: r.auth_token, addressB64: expected, walletUriBase: r.wallet_uri_base } },
        });
      }
      const { signed_payloads } = await wallet.signTransactions({ payloads: [txBase64] });
      const signed = signed_payloads[0];
      if (!signed) throw new Error("wallet_not_signed");
      return signed;
    },
    grant?.walletUriBase ? { baseUri: grant.walletUriBase } : undefined,
  );
}

export async function disconnect(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHE_KEY).catch(() => undefined);
}

// The two outcomes a screen must tell apart from a real failure: the user backed out (the sheet
// was dismissed, authorization declined, nothing signed) and there is no wallet app at all.
// A session TIMEOUT is neither — the wallet did not answer — and surfaces as an ordinary failure.
export function isUserCancel(e: unknown): boolean {
  if (e instanceof SolanaMobileWalletAdapterError) {
    return (
      e.code === SolanaMobileWalletAdapterErrorCode.ERROR_ASSOCIATION_CANCELLED ||
      e.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED
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
