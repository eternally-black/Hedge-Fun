import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isContextPoor, isVagueEsports, withinCategoryHorizon, DECK_FETCH_HORIZON_HOURS } from "@/lib/deck-mix";
import { DECK_MIN_LEAD_MS, FEED_BAND_BP, FEED_PAGE_SIZE } from "@/lib/config";
import type { FeedResponse } from "@/lib/api-types";

// The feed ("лента"): what takes over once the daily swipe deck is spent. An endless, CRYPTO-FIRST
// stream of near-50% binary markets across ALL tiers. Reads the same Market cache as the deck, but:
//  - tighter price band (FEED_BAND_BP, ~near-50%) instead of the deck's wide 15–85% contested band;
//  - NO category shuffle — ordering by resolutionDeadline ASC front-loads crypto for free (crypto
//    Up/Down resolve in minutes; sports/esports are 1–3 days out), so variety widens as you scroll;
//  - cursor (keyset) pagination for infinite scroll, stable across the live cache (no repeats/gaps).
const FEED_WINDOW_HOURS = DECK_FETCH_HORIZON_HOURS; // outer bound; per-category horizon applied below
// Over-fetch so post-query quality filtering (context-poor / vague-esports / per-category horizon)
// can drop rows and still fill a page. The band is tight, so most rows survive — 3× is plenty.
const TAKE_RAW = FEED_PAGE_SIZE * 3;

// Opaque keyset cursor = "<resolutionDeadline ISO>|<id>". base64 so the client treats it as opaque.
function encodeCursor(deadline: Date, id: string): string {
  return Buffer.from(`${deadline.toISOString()}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(raw: string): { deadline: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const deadline = new Date(iso!);
    if (!id || Number.isNaN(deadline.getTime())) return null;
    return { deadline, id };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const max = new Date(now.getTime() + FEED_WINDOW_HOURS * 3_600_000);
  const cursor = new URL(req.url).searchParams.get("cursor");
  const after = cursor ? decodeCursor(cursor) : null;

  const candidates = await prisma.market.findMany({
    where: {
      status: "OPEN",
      // Near-50% band on BOTH sides — the feed's editorial filter (coin-flips, fair shard odds).
      // Tighter than the deck, so decided/lopsided markets are excluded for free.
      yesPriceBp: { gte: FEED_BAND_BP.min, lte: FEED_BAND_BP.max },
      noPriceBp: { gte: FEED_BAND_BP.min, lte: FEED_BAND_BP.max },
      bets: { none: { userId: user.id } }, // anti-join: never re-serve a market the user already bet (deck or feed)
      AND: [
        // Base freshness window: above the lead cutoff, within the widest per-category horizon.
        { resolutionDeadline: { gt: new Date(now.getTime() + DECK_MIN_LEAD_MS), lte: max } },
        // Keyset: strictly past the cursor in (resolutionDeadline, id) order — stable, no repeats.
        ...(after
          ? [{ OR: [{ resolutionDeadline: { gt: after.deadline } }, { resolutionDeadline: after.deadline, id: { gt: after.id } }] }]
          : []),
      ],
    },
    orderBy: [{ resolutionDeadline: "asc" }, { id: "asc" }],
    take: TAKE_RAW,
    select: {
      id: true,
      question: true,
      category: true,
      outcomeYesLabel: true,
      outcomeNoLabel: true,
      yesPriceBp: true,
      noPriceBp: true,
      resolutionDeadline: true,
    },
  });

  // Same quality drops as the deck (context-poor O/U, vague esports, drifted-past-horizon rows).
  const nowMs = now.getTime();
  const usable = candidates.filter(
    (c) => !isContextPoor(c) && !isVagueEsports(c) && withinCategoryHorizon(c, c.resolutionDeadline.getTime(), nowMs),
  );
  const cut = usable.slice(0, FEED_PAGE_SIZE); // candidates/usable are in (deadline,id) order, so cut.last is the max

  // Cursor advance:
  //  - more usable beyond this page → continue from the last SHOWN row (the leftover re-reads next page);
  //  - none usable this chunk but the DB had a full chunk (a filtered dead-zone) → jump past it to raw.last;
  //  - DB chunk wasn't full AND we showed everything usable → end of pool → null.
  const moreInDb = candidates.length === TAKE_RAW;
  let nextCursor: string | null = null;
  if (usable.length > cut.length) {
    const last = cut[cut.length - 1]!;
    nextCursor = encodeCursor(last.resolutionDeadline, last.id);
  } else if (moreInDb) {
    const last = candidates[candidates.length - 1]!;
    nextCursor = encodeCursor(last.resolutionDeadline, last.id);
  }

  const body: FeedResponse = {
    cards: cut.map((c) => ({
      ...c,
      yesPriceBp: c.yesPriceBp!, // band-filtered above → non-null
      noPriceBp: c.noPriceBp!,
      resolutionDeadline: c.resolutionDeadline.toISOString(),
    })),
    nextCursor,
  };
  return NextResponse.json(body);
}
