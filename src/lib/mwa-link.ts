// Mobile Wallet Adapter wallet link — the proof that a Seeker user HOLDS the key of the wallet they
// want to trade from. Privy proves this for web-linked wallets (it ran the challenge); MWA sits
// outside Privy, so the native app asks the wallet to Sign In With Solana (SIWS) with a nonce we
// issued, and this module verifies the result. A verified address gets HedgeWallet.verifiedAt, the
// same flag a Privy-linked wallet gets, so /api/stocks/real/tx accepts it as `payer` unchanged.
//
// Pure (no prisma, no request): the route is a thin wrapper, the test drives this file directly.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddressDecoder, getPublicKeyFromAddress, signatureBytes, verifySignature, type Address } from "@solana/kit";

export const MWA_NONCE_TTL_MS = 10 * 60_000;
export const SIWS_STATEMENT = "Link this wallet to your Hedge Fun account as a trading wallet.";

// HMAC key for nonces. Reuses the Privy app secret when no dedicated one is set: both are already
// server-only, and a nonce forged without the key is the only thing this protects against.
function nonceKey(): string {
  const k = process.env.MWA_LINK_SECRET ?? process.env.PRIVY_APP_SECRET ?? "";
  if (!k) throw new Error("MWA_LINK_SECRET or PRIVY_APP_SECRET required");
  return k;
}

// Stateless nonce: <issued-at, base36, 10 chars><hmac(userId|issuedAt), 32 hex chars>. No table, no
// cleanup; a nonce is bound to one user and dies after MWA_NONCE_TTL_MS. Alphanumeric only — the
// SIWS spec requires it ("an alphanumeric string containing a minimum of 8 characters").
const TS_WIDTH = 10;
const MAC_WIDTH = 32;
function mac(userId: string, ts36: string, key: string): string {
  return createHmac("sha256", key).update(`${userId}|${ts36}`).digest("hex").slice(0, MAC_WIDTH);
}
export function mwaNonce(userId: string, now = Date.now(), key = nonceKey()): string {
  const ts36 = now.toString(36).padStart(TS_WIDTH, "0");
  return ts36 + mac(userId, ts36, key);
}
export function checkMwaNonce(nonce: string, userId: string, now = Date.now(), key = nonceKey()): "ok" | "expired" | "bad" {
  if (nonce.length !== TS_WIDTH + MAC_WIDTH) return "bad";
  const ts36 = nonce.slice(0, TS_WIDTH);
  const given = Buffer.from(nonce.slice(TS_WIDTH), "utf8");
  const want = Buffer.from(mac(userId, ts36, key), "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return "bad";
  const issuedAt = parseInt(ts36, 36);
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000) return "bad"; // from the future = forged clock
  return now - issuedAt > MWA_NONCE_TTL_MS ? "expired" : "ok";
}

// The SIWS message the wallet signed (phantom/sign-in-with-solana ABNF): line 1 is
// "<domain> wants you to sign in with your Solana account:", line 2 the base58 address, then an
// optional statement and optional "Key: value" advanced fields. Only the three we bind are read.
export function parseSiws(text: string): { domain: string; address: string; nonce: string | null } | null {
  const lines = text.split("\n");
  const head = /^(.+) wants you to sign in with your Solana account:$/.exec(lines[0] ?? "");
  const address = (lines[1] ?? "").trim();
  if (!head || !address) return null;
  const nonceLine = lines.find((l) => l.startsWith("Nonce: "));
  return { domain: head[1], address, nonce: nonceLine ? nonceLine.slice("Nonce: ".length).trim() : null };
}

export type SiwsLinkError =
  | "bad_encoding" // not base64 / wrong lengths (32-byte key, 64-byte signature)
  | "bad_message" // not a SIWS message
  | "domain_mismatch" // signed for another site
  | "address_mismatch" // message names a different account than the one that signed
  | "bad_nonce" // not ours / not this user's
  | "nonce_expired"
  | "bad_signature";
export type SiwsLinkResult = { ok: true; address: Address } | { ok: false; error: SiwsLinkError };

export interface SiwsLinkInput {
  // The wallet's sign_in_result, verbatim (MWA spec: all base64).
  addressB64: string;
  signedMessageB64: string;
  signatureB64: string;
  userId: string; // whose nonce it must be
  expectedDomain: string | null; // null = not enforced (APP_ORIGIN unset, dev)
  now?: number;
  key?: string;
}

export async function verifySiwsLink(i: SiwsLinkInput): Promise<SiwsLinkResult> {
  const pubkey = Buffer.from(i.addressB64, "base64");
  const msg = Buffer.from(i.signedMessageB64, "base64");
  const sig = Buffer.from(i.signatureB64, "base64");
  if (pubkey.length !== 32 || sig.length !== 64 || msg.length === 0) return { ok: false, error: "bad_encoding" };

  const address = getAddressDecoder().decode(pubkey);
  const parsed = parseSiws(msg.toString("utf8"));
  if (!parsed) return { ok: false, error: "bad_message" };
  if (i.expectedDomain && parsed.domain !== i.expectedDomain) return { ok: false, error: "domain_mismatch" };
  if (parsed.address !== address) return { ok: false, error: "address_mismatch" };
  if (!parsed.nonce) return { ok: false, error: "bad_nonce" };
  const n = checkMwaNonce(parsed.nonce, i.userId, i.now, i.key);
  if (n !== "ok") return { ok: false, error: n === "expired" ? "nonce_expired" : "bad_nonce" };

  const key = await getPublicKeyFromAddress(address);
  const valid = await verifySignature(key, signatureBytes(new Uint8Array(sig)), new Uint8Array(msg));
  return valid ? { ok: true, address } : { ok: false, error: "bad_signature" };
}
