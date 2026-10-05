// Live status of real orders the user just swiped — the deck flies the card at once and keeps going,
// so the answer (filled / waiting on the exchange / refused) arrives while they are already on the
// next card. This module is the one place that answer lives; the deck writes it, and whichever
// indicator style is selected (OrderTray: A above the buttons, B under the deck pill, C a HUD badge,
// D the bell itself)
// reads it. Module-level on purpose: the deck, the HUD and the toast host are different trees.
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

export type OrderState = "pending" | "filled" | "posted" | "failed";
export type OrderStatusItem = {
  id: number;
  label: string; // the side the user picked, as the card named it ("Kazakhstan", "Over 5.5", "No")
  side: "YES" | "NO";
  state: OrderState;
  detail?: string; // "1.56 sh", "Price moved — next card", …
};

// How long a settled chip stays before it fades: a fill is good news and can go quickly; a refusal
// needs a beat longer to be read.
const LINGER_MS: Record<Exclude<OrderState, "pending">, number> = { filled: 2200, posted: 4000, failed: 4500 };

let items: OrderStatusItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function pushOrder(label: string, side: "YES" | "NO"): number {
  const id = ++seq;
  items = [...items, { id, label, side, state: "pending" }];
  emit();
  return id;
}

export function settleOrder(id: number, state: Exclude<OrderState, "pending">, detail?: string): void {
  if (!items.some((i) => i.id === id)) return;
  items = items.map((i) => (i.id === id ? { ...i, state, detail } : i));
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

// ── Which indicator is shown (an A/B/C test the owner switches in Profile) ──
export type TrayStyle = "A" | "B" | "C" | "D";
const STYLE_KEY = "hf_order_tray_style_v1"; // SecureStore: the store the app already uses for prefs
let style: TrayStyle = "D"; // the owner's pick so far (2026-10-05); A/B/C stay switchable
let styleLoaded = false;
const styleListeners = new Set<() => void>();

function loadStyle(): void {
  if (styleLoaded) return;
  styleLoaded = true;
  SecureStore.getItemAsync(STYLE_KEY)
    .then((v) => {
      if (v === "A" || v === "B" || v === "C" || v === "D") { style = v; styleListeners.forEach((l) => l()); }
    })
    .catch(() => undefined);
}

export function setTrayStyle(next: TrayStyle): void {
  style = next;
  styleListeners.forEach((l) => l());
  SecureStore.setItemAsync(STYLE_KEY, next).catch(() => undefined);
}

const subscribeStyle = (l: () => void) => {
  loadStyle(); // first subscriber reads the stored choice; the default shows until it lands
  styleListeners.add(l);
  return () => { styleListeners.delete(l); };
};
const styleSnapshot = () => style;

export function useTrayStyle(): TrayStyle {
  return useSyncExternalStore(subscribeStyle, styleSnapshot, styleSnapshot);
}
