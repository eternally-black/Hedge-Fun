// Live status of real orders the user just swiped — the deck flies the card at once and keeps going,
// so the answer (filled / waiting on the exchange / refused) arrives while they are already on the
// next card. The deck writes it here; the HUD bell reads it (OrderStatusBell): a spinning ring with
// the count in flight, resolving to ✓ / ✕. Module-level on purpose: the deck and the HUD are
// different trees, and a status change must re-render the bell, not the deck.
import { useSyncExternalStore } from "react";

export type OrderState = "pending" | "filled" | "posted" | "failed";
export type OrderStatusItem = {
  id: number;
  side: "YES" | "NO";
  state: OrderState;
};

// How long a settled order keeps the bell showing its result before the bell comes back: a fill is
// good news and can go quickly; a refusal needs a beat longer (its toast says why).
const LINGER_MS: Record<Exclude<OrderState, "pending">, number> = { filled: 2200, posted: 3000, failed: 4000 };

let items: OrderStatusItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function pushOrder(side: "YES" | "NO"): number {
  const id = ++seq;
  items = [...items, { id, side, state: "pending" }];
  emit();
  return id;
}

export function settleOrder(id: number, state: Exclude<OrderState, "pending">): void {
  if (!items.some((i) => i.id === id)) return;
  items = items.map((i) => (i.id === id ? { ...i, state } : i));
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== id);
    emit();
  }, LINGER_MS[state]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const snapshot = () => items;

export function useOrderStatus(): OrderStatusItem[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
