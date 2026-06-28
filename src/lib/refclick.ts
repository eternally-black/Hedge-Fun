import { createHmac } from "node:crypto";
import { prisma } from "./prisma";

// Referral-click logging + cross-browser attribution lookup. The click is logged BEFORE signup
// so a referral survives the device losing its cookie — the common mobile case is clicking a
// link in an in-app browser (Telegram/X) then opening the app in the system browser, which is a
// different cookie/localStorage jar. IP+UA hashes bridge that gap; CGNAT collisions are handled
// by abstaining (see lookupReferralByDevice).
//
// ip/ua are HMAC-SHA256, never stored plaintext — defense in depth against a DB dump, not a
// privacy guarantee. If REFERRAL_HASH_SECRET is unset the whole device-fallback is disabled
// gracefully (returns null) — the cookie path still works; we just lose cross-browser recovery.

const SECRET = process.env.REFERRAL_HASH_SECRET ?? "";
export const deviceFallbackEnabled = SECRET.length > 0;

const ATTRIBUTION_WINDOW_DAYS = 7;

// Return a plain Uint8Array backed by a fresh ArrayBuffer (not Node's Buffer / a SharedArrayBuffer)
// — Prisma's Bytes field types strictly as Uint8Array<ArrayBuffer>. The copy guarantees that.
function hmac(value: string): Uint8Array<ArrayBuffer> {
  const d = createHmac("sha256", SECRET).update(value).digest();
  const out = new Uint8Array(d.byteLength);
  out.set(d);
  return out;
}

// First entry of x-forwarded-for is the originating client; later entries are proxy hops.
// Falls back to x-real-ip, then a sentinel (so hashing never throws on a missing header).
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() ?? "0.0.0.0";
}

// The two device signals, hashed. accept-language is mixed into the UA hash so two devices behind
// one IP with different locales (RU vs EN UI) don't collide. Returns null when no secret is set.
export function deviceHashes(headers: Headers): { ipHash: Uint8Array<ArrayBuffer>; uaHash: Uint8Array<ArrayBuffer> } | null {
  if (!deviceFallbackEnabled) return null;
  const ip = clientIp(headers);
  const ua = headers.get("user-agent") ?? "";
  const lang = headers.get("accept-language") ?? "";
  return { ipHash: hmac(ip), uaHash: hmac(`${ua}\n${lang}`) };
}

// A device fingerprint = the (ipHash, uaHash) pair. Used by the referral self/multi-account guard
// (referral.ts captureReferral) to reject a binding when inviter and invitee are the same device.
export type DeviceFingerprint = { ipHash: Uint8Array<ArrayBuffer>; uaHash: Uint8Array<ArrayBuffer> };

// Same-device test: both hashes must match. Hashes are HMAC-SHA256 (32 bytes); compare byte-wise.
export function sameDevice(a: DeviceFingerprint, b: DeviceFingerprint): boolean {
  return bytesEqual(a.ipHash, b.ipHash) && bytesEqual(a.uaHash, b.uaHash);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Resolve a user's SIGNUP device fingerprint for the referral self/multi-account guard. The device
// (HMAC of IP / UA+lang) is captured once at account creation (privy.ts ensureUser writes
// User.signupIpHash/signupUaHash). captureReferral compares the inviter's and invitee's stored
// signup devices and rejects when they match — sound and symmetric: a real inviter and invitee sign
// up on different devices -> different hashes -> allowed; one person spinning up two accounts on the
// same device -> equal hashes -> rejected. (This replaces the old self-click inference, which was
// circular — a code's clicks are usually the INVITEE's, so it would wrongly reject real referrals.)
//
// ON by default whenever REFERRAL_HASH_SECRET is set; kill-switch REFERRAL_DEVICE_GUARD="0" disables.
// ponytail ceiling: a genuinely shared device (household / library) trips a false reject — accepted,
// since rewards are virtual points and the guard requires BOTH ipHash AND uaHash to match (shared
// wifi + a different phone still binds). Returns null when hashing is disabled, the guard is off, the
// user is missing, or that user has no stored signup device (pre-guard account -> skipped, fail open).
const deviceGuardEnabled = deviceFallbackEnabled && process.env.REFERRAL_DEVICE_GUARD !== "0";

export async function resolveUserDevice(userId: string): Promise<DeviceFingerprint | null> {
  if (!deviceGuardEnabled) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { signupIpHash: true, signupUaHash: true },
  });
  if (!user?.signupIpHash || !user?.signupUaHash) return null;
  return {
    ipHash: toArrayBufferBytes(user.signupIpHash),
    uaHash: toArrayBufferBytes(user.signupUaHash),
  };
}

// Prisma returns Bytes as Uint8Array; normalize to the Uint8Array<ArrayBuffer> the guard compares.
function toArrayBufferBytes(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
}

// Log a click. Best-effort: a failure here must never block the redirect/response, so callers
// fire-and-forget. No-op if hashing is disabled (no secret).
export async function logReferralClick(code: string, headers: Headers): Promise<void> {
  const h = deviceHashes(headers);
  if (!h) return;
  await prisma.referralClick.create({ data: { code, ipHash: h.ipHash, uaHash: h.uaHash } });
}

// Cross-browser fallback: given a fresh signup with no hf_ref cookie, find the referral code we
// logged for this device in the last 7 days. Returns null when:
//   - no secret (fallback disabled),
//   - no click under this (ipHash, uaHash),
//   - MULTIPLE distinct codes match (CGNAT collision — abstain rather than guess wrong).
export async function lookupReferralByDevice(headers: Headers): Promise<string | null> {
  const h = deviceHashes(headers);
  if (!h) return null;
  const since = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * 86_400_000);
  // Pull up to 2 DISTINCT codes — if there are 2, it's a collision and we abstain.
  const rows = await prisma.referralClick.findMany({
    where: { ipHash: h.ipHash, uaHash: h.uaHash, createdAt: { gt: since } },
    distinct: ["code"],
    select: { code: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0]!.code : null;
}
