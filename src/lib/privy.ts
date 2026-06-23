import { PrivyClient, type User as PrivyUser } from "@privy-io/server-auth";
import type { User } from "@prisma/client";
import { prisma } from "./prisma";
import { START_BALANCE_CENTS } from "./config";

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
function extractIdentity(pu: PrivyUser): {
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
// User + VirtualBalance@$1000 + CollectibleBalance + Streak + today's DailyCounter, all
// in one transaction so a user is never half-initialised.
export async function ensureUser(privyId: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { privyId } });
  if (existing) return existing;
  // ponytail: no per-request lastSeenAt write (M3) — a write on every authed read is
  // wasteful; the daily GM / login-mark is a good-enough heartbeat if we need one later.

  const pu = await privy.getUser(privyId);
  const id = extractIdentity(pu);

  return prisma.user.create({
    data: {
      privyId,
      authProvider: id.authProvider,
      email: id.email,
      twitterHandle: id.twitterHandle,
      embeddedWalletAddress: id.wallet,
      lastSeenAt: new Date(),
      virtualBalance: { create: { balanceCents: START_BALANCE_CENTS } },
      collectibleBalance: { create: {} },
      streak: { create: {} },
    },
  });
}

// Convenience for API routes: verify the request and return the app user, or null.
export async function authUser(req: Request): Promise<User | null> {
  const token = bearer(req);
  if (!token) return null;
  try {
    const privyId = await verifyPrivyToken(token);
    return await ensureUser(privyId);
  } catch {
    return null;
  }
}
