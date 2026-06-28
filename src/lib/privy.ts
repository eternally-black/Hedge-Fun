import { PrivyClient, type User as PrivyUser } from "@privy-io/server-auth";
import { Prisma, type User } from "@prisma/client";
import { prisma } from "./prisma";
import { START_BALANCE_CENTS } from "./config";
import { newReferralCode } from "./refcode";
import { deviceHashes, type DeviceFingerprint } from "./refclick";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? "";

const privy = new PrivyClient(APP_ID, APP_SECRET);

// Verify the Privy access token (from the Authorization: Bearer header) and return the
// Privy DID. Throws if invalid/expired — callers turn that into a 401.
export async function verifyPrivyToken(token: string): Promise<string> {
  const claims = await privy.verifyAuthToken(token);
  return claims.userId; // Privy DID, e.g. "did:privy:..."
}

// Pull the Bearer token out of a request's Authorization header.
export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Read identity fields from the Privy user's linked accounts.
export function extractIdentity(pu: PrivyUser): {
  authProvider: "EMAIL" | "TWITTER";
  email: string | null;
  twitterHandle: string | null;
  wallet: string | null;
} {
  let email: string | null = pu.email?.address ?? null;
  let twitterHandle: string | null = pu.twitter?.username ?? null;
  let wallet: string | null = pu.wallet?.address ?? null;

  for (const acct of pu.linkedAccounts ?? []) {
    if (acct.type === "email" && !email) email = acct.address;
    if (acct.type === "twitter_oauth" && !twitterHandle) twitterHandle = acct.username ?? null;
    if (acct.type === "wallet" && !wallet) wallet = acct.address;
  }

  return {
    authProvider: twitterHandle && !email ? "TWITTER" : "EMAIL",
    email,
    twitterHandle,
    wallet,
  };
}

// Provision (or fetch) the app user for a verified Privy DID. First login creates the
// User + VirtualBalance ($200, START_BALANCE_CENTS) + CollectibleBalance + Streak, all
// in one transaction so a user is never half-initialised.
export async function ensureUser(privyId: string, device?: DeviceFingerprint | null): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { privyId } });
  if (existing) return existing;
  // ponytail: no per-request lastSeenAt write (M3) — a write on every authed read is
  // wasteful; the daily GM / login-mark is a good-enough heartbeat if we need one later.

  const pu = await privy.getUser(privyId);
  const id = extractIdentity(pu);

  try {
    return await prisma.user.create({
      data: {
        privyId,
        authProvider: id.authProvider,
        email: id.email,
        twitterHandle: id.twitterHandle,
        embeddedWalletAddress: id.wallet,
        referralCode: await newReferralCode(), // short code (was @default(cuid()))
        lastSeenAt: new Date(),
        signupIpHash: device?.ipHash ?? null,
        signupUaHash: device?.uaHash ?? null,
        virtualBalance: { create: { balanceCents: START_BALANCE_CENTS } },
        collectibleBalance: { create: {} },
        streak: { create: {} },
      },
    });
  } catch (e) {
    // First-login race: /api/me and /api/deck both call ensureUser in parallel, both
    // findUnique→null, both create → the loser hits the privyId unique constraint (P2002).
    // That's fine — the winner already provisioned the user; just read it back.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const created = await prisma.user.findUnique({ where: { privyId } });
      if (created) return created;
      // P2002 but NOT this privyId -> a referralCode collision (two new users drew the same
      // 4-char code concurrently — astronomically rare). Retry once with a fresh code.
      return await prisma.user.create({
        data: {
          privyId,
          authProvider: id.authProvider,
          email: id.email,
          twitterHandle: id.twitterHandle,
          embeddedWalletAddress: id.wallet,
          referralCode: await newReferralCode(),
          lastSeenAt: new Date(),
          signupIpHash: device?.ipHash ?? null,
          signupUaHash: device?.uaHash ?? null,
          virtualBalance: { create: { balanceCents: START_BALANCE_CENTS } },
          collectibleBalance: { create: {} },
          streak: { create: {} },
        },
      });
    }
    throw e;
  }
}

// Read the live Privy user (linked accounts incl. twitter). Used by /api/link/sync to back-fill
// twitterHandle after the client links via useLinkAccount — extractIdentity only runs at ensureUser
// (first login), so a later link wouldn't reach our DB otherwise. (Unlinking is done client-side via
// usePrivy().unlinkTwitter — this server SDK version has no unlink method.)
export async function getPrivyUser(privyId: string): Promise<PrivyUser> {
  return privy.getUser(privyId);
}

// Convenience for API routes: verify the request and return the app user, or null.
export async function authUser(req: Request): Promise<User | null> {
  const token = bearer(req);
  if (!token) return null;
  try {
    const privyId = await verifyPrivyToken(token);
    // Capture the signup device on first login (deviceHashes is null without REFERRAL_HASH_SECRET —
    // fail-safe). ensureUser writes it only on create, so this is the per-user signup fingerprint.
    return await ensureUser(privyId, deviceHashes(req.headers));
  } catch (e) {
    // Token verify failures are the normal unauthorized path (expired/invalid) — quiet.
    // But a thrown ensureUser (DB/Privy error) was silently becoming a 401 and hiding bugs;
    // log those so they're visible.
    if (!(e instanceof Error && /token|jwt|auth/i.test(e.message))) {
      console.error("[authUser] ensureUser failed:", e);
    }
    return null;
  }
}
