// GET /api/real/positions — the console's read of the user's own REAL money: what is open, what it
// cost, what has been realized. Paper history has its own route (/api/history filters mode=PAPER).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { hasRealConsent } from "@/lib/real";

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Consent-gated but NOT eligibility-gated: a flipped allowlist must never hide someone's own open
  // positions from them (same rule that keeps the recovery verbs off the allowlist).
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });

  const bets = await prisma.bet.findMany({
    where: { userId: user.id, mode: "REAL" },
    include: { market: { select: { question: true, status: true, resolvedOutcome: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const positions = bets.map((bet) => {
    // Every money column is a nullable BigInt: JSON.stringify throws on BigInt, and a null means
    // "nothing booked yet", which reads as zero.
    const filled = bet.filledSharesMicro ?? 0n;
    const closed = bet.closedSharesMicro ?? 0n;
    return {
      id: bet.id,
      marketId: bet.marketId,
      question: bet.market.question,
      side: bet.side,
      status: bet.market.status,
      resolvedOutcome: bet.market.resolvedOutcome,
      settlementStatus: bet.settlementStatus,
      filledSharesMicro: filled.toString(),
      closedSharesMicro: closed.toString(),
      openSharesMicro: (filled - closed).toString(),
      spendMicro: (bet.spendMicro ?? 0n).toString(),
      feeMicro: (bet.feeMicro ?? 0n).toString(),
      proceedsMicro: (bet.proceedsMicro ?? 0n).toString(),
      realizedPnlMicro: (bet.realizedPnlMicro ?? 0n).toString(),
    };
  });

  return NextResponse.json({ positions }, { headers: { "Cache-Control": "no-store" } });
}
