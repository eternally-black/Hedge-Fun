import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { quoteMarketForDisplay } from "@/lib/depth";
import {
  STAKE_CENTS,
  HEDGE_MIN_STAKE_CENTS,
  HEDGE_MAX_STAKE_CENTS,
  QUOTES_MAX_IDS,
  QUOTES_RATE_PER_MIN,
} from "@/lib/config";
import type { QuoteRow, QuotesResponse } from "@/lib/api-types";

// Live executable prices for the cards the user is currently looking at (D10 Slice B).
//
// Why this exists: the deck serves a price read from the book at poller time, but a CLOB book churns
// roughly every 5 seconds. A card that sits on top while the user deliberates is showing a number
// that was true when it was dealt, not now. This endpoint is what makes the displayed payout track
// reality, and it is what the swipe's seen-vs-executed check compares against.
//
// Cost shape: the client sends only the cards it can SEE (the top one, in practice), and the book
// cache in src/lib/clob.ts is process-wide and shared — so N users watching the same market collapse
// to one upstream /books call per cache TTL, not N. That is why a 3s client cadence is affordable.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`quotes:${user.id}`, QUOTES_RATE_PER_MIN, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const url = new URL(req.url);
  // Dedupe before the cap so a client repeating one id can't crowd out the others it asked for.
  const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))]
    .slice(0, QUOTES_MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });

  // Stake is user-controlled input to a book walk. Clamp rather than reject: an out-of-range value
  // is far more likely a stale client than an attack, and a clamped quote is still honest.
  const rawStake = Number(url.searchParams.get("stake"));
  const stakeCents = Number.isFinite(rawStake) && rawStake > 0
    ? Math.min(Math.max(Math.round(rawStake), HEDGE_MIN_STAKE_CENTS), HEDGE_MAX_STAKE_CENTS)
    : STAKE_CENTS;

  const markets = await prisma.market.findMany({
    where: { id: { in: ids }, status: "OPEN" },
    select: {
      id: true,
      source: true,
      yesTokenId: true,
      noTokenId: true,
      yesPriceBp: true,
      noPriceBp: true,
    },
  });

  const quotes: QuoteRow[] = await Promise.all(
    markets.map(async (m): Promise<QuoteRow> => {
      // TXODDS football has no CLOB book at all — its synthetic odds are authoritative, not a
      // degraded read. Echo them back with live:false so the client knows there is nothing to poll.
      if (m.source === "TXODDS" || !m.yesTokenId || !m.noTokenId) {
        return {
          marketId: m.id,
          yesPriceBp: m.yesPriceBp,
          noPriceBp: m.noPriceBp,
          asOfMs: null,
          live: false,
        };
      }
      const q = await quoteMarketForDisplay(m.yesTokenId, m.noTokenId, stakeCents);
      return {
        marketId: m.id,
        yesPriceBp: q.yesPriceBp,
        noPriceBp: q.noPriceBp,
        asOfMs: q.asOfMs,
        live: true,
      };
    }),
  );

  // Markets that vanished (resolved/closed between deal and poll) are simply absent from `quotes` —
  // the client keeps showing what it has and the existing expiry prune / swipe 409 handle the rest.
  const res: QuotesResponse = { quotes };
  return NextResponse.json(res);
}
