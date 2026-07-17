// Suggestion telemetry (impression / dismiss). ACCEPT is recorded inside acceptSuggestion; this
// covers the other two lifecycle events. Re-derives the suggestion (cache-only) to attach the same
// context the accept path stores, then upserts on the (user, suggestion, event) unique key so a
// re-send is idempotent. Returns false when the id no longer resolves (stale) so the route can 404.

import { prisma } from "../prisma";
import { deriveForUser } from "./suggest";

export async function recordSuggestionEvent(
  userId: string,
  sid: string,
  event: "IMPRESSION" | "DISMISS",
): Promise<boolean> {
  const { items } = await deriveForUser(userId, { cacheOnly: true });
  const item = items.find((i) => i.suggestion.suggestionId === sid);
  if (!item) return false;
  const s = item.suggestion;

  await prisma.hedgeSuggestionEvent.upsert({
    where: { userId_suggestionId_event: { userId, suggestionId: sid, event } },
    create: {
      suggestionId: sid,
      userId,
      address: item.address,
      marketId: s.id,
      kind: item.enumKind,
      side: s.side,
      proposedStakeCents: s.proposedStakeCents,
      event,
    },
    update: {},
  });
  return true;
}
