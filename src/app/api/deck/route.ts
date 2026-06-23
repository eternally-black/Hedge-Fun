import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";

// The blitz deck: cached OPEN markets resolving within 24h, freshest deadline first.
// Reads the Market cache (populated by refresh-deck / the poller), not the live API.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const max = new Date(now.getTime() + 24 * 3_600_000);

  const markets = await prisma.market.findMany({
    where: {
      status: "OPEN",
      resolutionDeadline: { gt: now, lte: max },
      yesPriceBp: { not: null },
      noPriceBp: { not: null },
    },
    orderBy: { resolutionDeadline: "asc" },
    take: 50,
    select: {
      id: true,
      question: true,
      category: true,
      yesPriceBp: true,
      noPriceBp: true,
      resolutionDeadline: true,
    },
  });

  return NextResponse.json({ cards: markets });
}
