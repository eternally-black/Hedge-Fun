// Stable, deterministic suggestion id. A suggestion is NOT persisted — it is re-derived on demand
// from the (TTL-cached) snapshot + market index, so its id must be a pure function of its content.
// This lets /api/hedge/accept re-derive the same suggestion and stay idempotent: the id is the hash
// of address + market + kind + side + hedged notional.
//
// The S1 id deliberately does NOT hash the proposed stake (D10/A8). Today the stake is a pure
// function of the other inputs, so dropping it is a no-op; the moment the sizer clamps to BOOK
// CAPACITY (depth-aware sizing) the stake — and therefore the id — would move every few seconds
// with the book. That breaks the two things the id exists for: the GET-suggestions → POST-accept
// round-trip would re-derive a different id and 404, and a re-accept would miss the findFirst
// idempotency fast path, hit P2002, and throw a spurious "already bet this market" 409 instead of
// returning idempotent success. The stake stays a DISPLAY field, never an identity input.

import { createHash } from "node:crypto";

export function suggestionId(parts: {
  address: string;
  marketId: string;
  kind: string; // "S1_MAJOR" | "S1_PROXY"
  side: string; // "YES" | "NO"
  hedgedNotionalCents: number;
}): string {
  const canonical = [
    parts.address,
    parts.marketId,
    parts.kind,
    parts.side,
    parts.hedgedNotionalCents,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// S2 / FALLBACK suggestion id. Same scheme (content hash), but S2 has NO wallet/notional — a
// life-event suggestion is a pure function of (market, side, fixed stake, kind). This is what lets
// /accept re-derive it WITHOUT the original free-text query: enumerate open S2/fallback markets,
// hash each, match the id. The "S2v1" prefix keeps this namespace disjoint from S1 ids.
export function s2SuggestionId(parts: {
  marketId: string;
  kind: string; // "S2" | "FALLBACK"
  side: string; // "YES" | "NO"
  proposedStakeCents: number;
}): string {
  const canonical = ["S2v1", parts.kind, parts.marketId, parts.side, parts.proposedStakeCents].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// Cheap shape guard: EVERY suggestion id (S1 and S2/FALLBACK) is the low 32 hex chars of a sha256
// digest. A caller can reject a malformed id — truncated client state, telemetry spam — before doing
// ANY DB re-derivation (F14). It only proves the SHAPE; a well-formed id that no longer derives is
// still resolved to null downstream (stale → 404).
// Stock-card ids: content hashes like the others, namespaced "S3v1". Stake is NOT hashed (same
// reasoning as suggestionId); a spotted id does not hash the move either — re-derivation re-evaluates
// the trigger, and a faded move resolves to "stale" (404), which is the honest outcome.
export function stockSuggestionId(p: { kind: "S1_STOCK" | "S3_STOCK" | "SPOTTED"; symbol: string; address?: string; hedgedAsset?: string; hedgedNotionalCents?: number; category?: string; amountCents?: number }): string {
  const canonical = [
    "S3v1",
    p.kind,
    p.symbol,
    p.address ?? "",
    p.hedgedAsset ?? "",
    String(p.hedgedNotionalCents ?? 0),
    p.category ?? "",
    String(p.amountCents ?? 0),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function isHexSuggestionId(sid: string): boolean {
  return /^[0-9a-f]{32}$/.test(sid);
}
