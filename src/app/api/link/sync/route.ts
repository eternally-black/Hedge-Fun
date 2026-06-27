import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser, getPrivyUser, extractIdentity } from "@/lib/privy";

// POST /api/link/sync — Bearer, no body. Re-reads the caller's Privy linked accounts and writes
// twitterHandle into our DB. extractIdentity only runs at first login (ensureUser), so a handle
// linked afterwards via useLinkAccount never lands here otherwise. Idempotent.
// Errors: 401 (no/invalid token), 409 (twitter_taken — handle already on another account).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pu = await getPrivyUser(user.privyId);
  const { twitterHandle } = extractIdentity(pu);
  if (!twitterHandle) return NextResponse.json({ twitter: null }); // link not present yet
  if (twitterHandle === user.twitterHandle) return NextResponse.json({ twitter: twitterHandle });

  try {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { twitterHandle },
      select: { twitterHandle: true },
    });
    return NextResponse.json({ twitter: updated.twitterHandle });
  } catch (e) {
    // twitterHandle is @unique. Already on another account -> P2002. Don't 500 — the client toasts a
    // "contact support" message (the two accounts must be merged/resolved manually).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "twitter_taken" }, { status: 409 });
    }
    throw e;
  }
}
