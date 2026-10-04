// How many cards the deck stack mounts. Two (top + the one waiting behind it) right after the top
// changes; three once the hand-off has settled, so the card after next is mounted — invisibly — while
// nothing is moving, and the next swipe only promotes cards that already exist. Mounting a card face
// mid-fling blocked the UI thread for 100–150 ms on the Seeker, which was the hitch at every swipe.
import { useEffect, useState } from "react";
import { RISE_MS } from "./useSwipeCard";

const SETTLE_MS = RISE_MS + 80; // after the promoted card's rise has finished

export function useStackDepth(topId: string | undefined): number {
  const [settledId, setSettledId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!topId) return;
    const t = setTimeout(() => setSettledId(topId), SETTLE_MS);
    return () => clearTimeout(t);
  }, [topId]);
  return topId !== undefined && settledId === topId ? 3 : 2;
}
