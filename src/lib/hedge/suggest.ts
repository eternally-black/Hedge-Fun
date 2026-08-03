// Suggestion orchestrator (DB glue over the pure cores). Loads the S1-eligible market index +
// the caller's cached wallet exposure, runs matchS1 + sizeS1, and builds the HedgeSuggestion cards
// with stable ids + the optional avg-cost narrative. Suggestions are NOT stored — they are
// re-derivable, which is exactly what makes /accept idempotent (same inputs -> same suggestionId).

import { prisma } from "../prisma";
import { matchS1, type IndexedMarket } from "./match";
import { sizeS1 } from "./size";
import { suggestionId } from "./id";
import { WSOL_MINT } from "./exposure";
import type { HedgeAsset, ParsedDirection } from "./parse";
import { getSnapshot, getCachedSnapshot, type SnapshotData } from "./snapshot";
import { quoteSideForDisplay } from "../depth";
import type { HedgeSuggestion, HedgeSuggestionKind } from "../api-types";

// The Prisma HedgeSuggestionKind values (mirrored so this module stays @prisma/client-free at the
// type level). S1_* are wallet hedges; S2 / FALLBACK are the life-event + discovery kinds (A2).
export type PrismaHedgeKind = "S1_MAJOR" | "S1_PROXY" | "S2" | "FALLBACK";

// Internal derived item: the wire suggestion + the fields /accept and telemetry need (address, the
// Prisma enum kind) that don't belong in the public card shape. `address` is the hedged wallet for
// S1; empty string for S2/FALLBACK (no wallet in a life-event hedge).
export interface DerivedSuggestion {
  address: string;
  enumKind: PrismaHedgeKind;
  suggestion: HedgeSuggestion;
}

function wireKind(k: "S1_MAJOR" | "S1_PROXY"): HedgeSuggestionKind {
  return k === "S1_MAJOR" ? "S1-major" : "S1-proxy";
}

export function enumKind(wire: HedgeSuggestionKind): PrismaHedgeKind {
  switch (wire) {
    case "S1-major": return "S1_MAJOR";
    case "S1-proxy": return "S1_PROXY";
    case "S2": return "S2";
    case "fallback": return "FALLBACK";
  }
}

// Load parsed, S1-eligible, OPEN majors markets as the pure matcher's IndexedMarket[].
export async function loadIndexedMarkets(): Promise<IndexedMarket[]> {
  const rows = await prisma.marketMeta.findMany({
    where: {
      parseOk: true,
      asset: { in: ["BTC", "ETH", "SOL"] },
      direction: { not: null },
      strikeCents: { not: null },
      market: { is: { status: "OPEN" } },
    },
    select: {
      asset: true,
      direction: true,
      strikeCents: true,
      liquidityCents: true,
      parsedDeadline: true,
      market: { select: { id: true, yesPriceBp: true, noPriceBp: true, resolutionDeadline: true } },
    },
  });

  const out: IndexedMarket[] = [];
  for (const r of rows) {
    if (!r.asset || r.strikeCents == null || !r.direction) continue;
    const deadline = r.parsedDeadline ?? r.market.resolutionDeadline;
    out.push({
      marketId: r.market.id,
      asset: r.asset as HedgeAsset,
      direction: r.direction as ParsedDirection,
      strikeCents: r.strikeCents,
      deadlineMs: deadline.getTime(),
      liquidityCents: r.liquidityCents,
      yesPriceBp: r.market.yesPriceBp,
      noPriceBp: r.market.noPriceBp,
    });
  }
  return out;
}

// The "you bought at $X" line (D4) — only for a DIRECT major hedge (a proxy hedges an SPL aggregate,
// which has no single cost basis). Null whenever Birdeye is unavailable or has no cost for the asset.
function avgCostNarrative(snapshot: SnapshotData, hedgedAsset: string, isProxy: boolean): string | null {
  if (isProxy || !snapshot.avgCost) return null;
  const mint =
    hedgedAsset === "SOL" ? WSOL_MINT : snapshot.exposure.majors.find((a) => a.asset === hedgedAsset)?.mint ?? null;
  if (!mint) return null;
  const cents = snapshot.avgCost[mint];
  if (cents == null || !(cents > 0)) return null;
  const dollars = (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `You bought ${hedgedAsset} at ~$${dollars}`;
}

// Build the derived suggestions for one snapshot against the given market index.
//
// `quoteDisplay` splits the two callers apart:
//  - TRUE (GET /api/hedge/suggestions — the path whose cards a user ACTS on): every POLYMARKET card
//    is priced live off the CLOB at its OWN proposedStakeCents (D10 follow-up — a $1..$500 stake
//    walks the book very differently than the $10 deck VWAP, and the accept locks exactly this
//    quote, so the displayed payout is the honoured one). A side that won't quote -> the card is
//    dropped, never shown at a mid. A bookless-source row keeps its stored odds (authoritative there).
//  - FALSE (accept/telemetry re-derivation): no CLOB calls — those paths only need the suggestionId
//    (a hash of address/market/kind/side/notional — NOT of price or stake), and accept re-quotes
//    the lock itself. Quoting there would tax a fire-and-forget telemetry path for nothing.
export async function deriveSuggestions(
  snapshot: SnapshotData,
  indexed: IndexedMarket[],
  nowMs: number,
  opts: { quoteDisplay?: boolean } = {},
): Promise<DerivedSuggestion[]> {
  const candidates = matchS1(snapshot.exposure, indexed, nowMs);
  if (candidates.length === 0) return [];

  const markets = await prisma.market.findMany({
    where: { id: { in: candidates.map((c) => c.marketId) } },
    select: {
      id: true,
      question: true,
      category: true,
      outcomeYesLabel: true,
      outcomeNoLabel: true,
      yesPriceBp: true,
      noPriceBp: true,
      resolutionDeadline: true,
      status: true,
      source: true,
      yesTokenId: true,
      noTokenId: true,
    },
  });
  const byId = new Map(markets.map((m) => [m.id, m]));

  const items: DerivedSuggestion[] = [];
  for (const c of candidates) {
    const m = byId.get(c.marketId);
    if (!m || m.status !== "OPEN" || m.yesPriceBp == null || m.noPriceBp == null) continue;
    const stake = sizeS1(c.hedgedNotionalCents, c.kind);
    if (stake <= 0) continue; // below the min clamp -> not worth suggesting

    let yesPriceBp = m.yesPriceBp;
    let noPriceBp = m.noPriceBp;
    if (opts.quoteDisplay && m.source === "POLYMARKET") {
      // Price BOTH sides at the card's own stake: the hedge side drives the displayed payout (and
      // must match the accept's lock); the other side keeps the DeckCard contract ("the price this
      // side COSTS") honest at the same stake. If either won't quote, there is no honest card.
      if (!m.yesTokenId || !m.noTokenId) continue;
      const [yEff, nEff] = await Promise.all([
        quoteSideForDisplay(m.yesTokenId, stake),
        quoteSideForDisplay(m.noTokenId, stake),
      ]);
      if (yEff === null || nEff === null) continue;
      yesPriceBp = yEff;
      noPriceBp = nEff;
    }

    const sid = suggestionId({
      address: snapshot.address,
      marketId: c.marketId,
      kind: c.kind,
      side: c.side,
      hedgedNotionalCents: c.hedgedNotionalCents,
      // proposedStakeCents is NOT hashed (D10/A8): the id must not move when the sizer becomes
      // depth-aware — see src/lib/hedge/id.ts.
    });
    const sideLabel = c.side === "YES" ? m.outcomeYesLabel : m.outcomeNoLabel;

    items.push({
      address: snapshot.address,
      enumKind: c.kind,
      suggestion: {
        id: m.id,
        question: m.question,
        category: m.category,
        outcomeYesLabel: m.outcomeYesLabel,
        outcomeNoLabel: m.outcomeNoLabel,
        yesPriceBp,
        noPriceBp,
        resolutionDeadline: m.resolutionDeadline.toISOString(),
        suggestionId: sid,
        kind: wireKind(c.kind),
        side: c.side,
        sideLabel,
        proposedStakeCents: stake,
        hedgedAsset: c.hedgedAsset,
        hedgedNotionalCents: c.hedgedNotionalCents,
        isProxy: c.isProxy,
        avgBuyCostNarrative: avgCostNarrative(snapshot, c.hedgedAsset, c.isProxy),
      },
    });
  }
  return items;
}

// Derive every S1 suggestion for a user across their linked wallet(s). `cacheOnly` (used by /accept)
// reads only a pre-built snapshot — no external Helius/Jupiter/Birdeye calls — so accept stays fast
// and deterministic; a missing snapshot yields no items (the caller 404s as stale). `quoteDisplay`
// (the suggestions route only) live-quotes each card's prices at its own stake — see deriveSuggestions.
export async function deriveForUser(
  userId: string,
  opts: { cacheOnly?: boolean; quoteDisplay?: boolean } = {},
): Promise<{ items: DerivedSuggestion[]; walletLinked: boolean }> {
  const wallets = await prisma.hedgeWallet.findMany({ where: { userId }, select: { address: true } });
  if (wallets.length === 0) return { items: [], walletLinked: false };

  const nowMs = Date.now();
  const indexed = await loadIndexedMarkets();
  const items: DerivedSuggestion[] = [];
  for (const w of wallets) {
    const snap = opts.cacheOnly ? await getCachedSnapshot(w.address) : await getSnapshot(w.address);
    if (!snap) continue;
    items.push(...(await deriveSuggestions(snap, indexed, nowMs, { quoteDisplay: opts.quoteDisplay })));
  }
  return { items, walletLinked: true };
}
