// Stable, deterministic suggestion id. A suggestion is NOT persisted — it is re-derived on demand
// from the (TTL-cached) snapshot + market index, so its id must be a pure function of its content.
// This lets /api/hedge/accept re-derive the same suggestion and stay idempotent: the id is the hash
// of address + market + kind + side + the sizing inputs/outputs. Sizing is snapshot-based (not live
// price) so the id is stable across the GET-suggestions → POST-accept round-trip within one TTL.

import { createHash } from "node:crypto";

export function suggestionId(parts: {
  address: string;
  marketId: string;
  kind: string; // "S1_MAJOR" | "S1_PROXY"
  side: string; // "YES" | "NO"
  hedgedNotionalCents: number;
  proposedStakeCents: number;
}): string {
  const canonical = [
    parts.address,
    parts.marketId,
    parts.kind,
    parts.side,
    parts.hedgedNotionalCents,
    parts.proposedStakeCents,
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
