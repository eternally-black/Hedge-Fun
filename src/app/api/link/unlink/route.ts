import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";

// POST /api/link/unlink — Bearer, no body. Null our twitterHandle for an EMAIL-signup account. The
// client unlinks from Privy first (usePrivy().unlinkTwitter — this server SDK has no unlink method),
// then calls this to clear our DB. Forbidden for TWITTER-signup accounts (X is their login —
// unlinking would lock them out).
// Errors: 401 (no/invalid token), 403 (is_login_method).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.authProvider === "TWITTER") {
    return NextResponse.json({ error: "is_login_method" }, { status: 403 });
  }

  await prisma.user.update({ where: { id: user.id }, data: { twitterHandle: null } });
  return NextResponse.json({ twitter: null });
}
