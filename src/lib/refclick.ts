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

// Two hours, not seven days: the in-app-browser -> system-browser hop takes minutes, and every
// extra day is a day a planted click on a shared IP can claim a stranger's signup.
const ATTRIBUTION_WINDOW_MS = 2 * 60 * 60 * 1000;

// Return a plain Uint8Array backed by a fresh ArrayBuffer (not Node's Buffer / a SharedArrayBuffer)
// — Prisma's Bytes field types strictly as Uint8Array<ArrayBuffer>. The copy guarantees that.
function hmac(value: string): Uint8Array<ArrayBuffer> {
  const d = createHmac("sha256", SECRET).update(value).digest();
  const out = new Uint8Array(d.byteLength);
  out.set(d);
  return out;
}

// LAST entry of x-forwarded-for, not first: the leftmost entries are whatever the CLIENT sent and
// are only meaningful when every hop is honest. The rightmost value is the one our own proxy wrote
// (Caddy ≥2.5 additionally drops client-supplied XFF from untrusted peers, so in this topology the
// header holds exactly one entry — the real client). Reading the first entry made the rate-limit
// key and signupIpHash attacker-chosen behind any proxy that appends instead of replacing.
// Falls back to x-real-ip, then a sentinel (so hashing never throws on a missing header).
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
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

// Same-device test: the IP half ONLY. The UA half is attacker-chosen (a different UA string defeats
// it) so it cannot carry a same-human decision; the IP half is the one signal the client does not
// pick. The ceiling — a real friend on the same wifi is rejected — is accepted for a virtual-points
// reward, and the UA hash keeps its job in the click-attribution lookup where it narrows CGNAT
// collisions. Hashes are HMAC-SHA256 (32 bytes); compare byte-wise.
export function sameDevice(a: DeviceFingerprint, b: DeviceFingerprint): boolean {
  return bytesEqual(a.ipHash, b.ipHash);
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
// since rewards are virtual points and the guard requires the IP half to match (shared wifi + a
// different phone still binds). Returns null when hashing is disabled, the guard is off, or the user
// is missing — the caller decides whether a null means "guard off" or "device unknown".
const deviceGuardEnabled = deviceFallbackEnabled && process.env.REFERRAL_DEVICE_GUARD !== "0";
export function deviceGuardActive(): boolean {
  return deviceGuardEnabled;
}
export const deviceGuardStrictMode = deviceGuardEnabled && process.env.REFERRAL_DEVICE_GUARD_STRICT !== "0";

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
// fire-and-forget. No-op if hashing is disabled (no secret). Junk codes must not fill the table —
// the code must belong to a real user before we write a row.
export async function logReferralClick(code: string, headers: Headers): Promise<void> {
  const h = deviceHashes(headers);
  if (!h) return;
  const owner = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
  if (!owner) return;
  await prisma.referralClick.create({ data: { code, ipHash: h.ipHash, uaHash: h.uaHash } });
}

// Rows are only ever read inside the attribution window; nothing else pruned them. Delete the
// older ones so a planted-click backlog can't grow unbounded.
export async function pruneReferralClicks(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const r = await prisma.referralClick.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return r.count;
}

// Cross-browser fallback: given a fresh signup with no hf_ref cookie, find the referral code we
// logged for this device in the last two hours. Returns null when:
//   - no secret (fallback disabled),
//   - no click under this (ipHash, uaHash),
//   - MULTIPLE distinct codes match (CGNAT collision — abstain rather than guess wrong).
export async function lookupReferralByDevice(headers: Headers): Promise<string | null> {
  const h = deviceHashes(headers);
  if (!h) return null;
  const since = new Date(Date.now() - ATTRIBUTION_WINDOW_MS);
  // Pull up to 2 DISTINCT codes — if there are 2, it's a collision and we abstain.
  const rows = await prisma.referralClick.findMany({
    where: { ipHash: h.ipHash, uaHash: h.uaHash, createdAt: { gt: since } },
    distinct: ["code"],
    select: { code: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0]!.code : null;
}
