// Which verified wallet the app trades from — the native twin of the pick half of
// src/app/useTradingWallet.ts. One tiny external store rather than component state: the deck CTA,
// the portfolio and the Profile all read it, and a pick on the Profile moves every one of them in
// the same render. Persisted on the device; the server's verified list (me.stockWallets) decides
// whether the remembered pick is still usable.
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

const KEY = "hf_trading_wallet_v1";
const listeners = new Set<() => void>();
let choice: string | null = null;
let loaded = false;
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** Read the remembered pick once (Root calls it at boot); later calls are no-ops. */
export async function loadTradingWalletChoice(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    choice = await SecureStore.getItemAsync(KEY);
  } catch {
    choice = null;
  }
  emit();
}

export function setTradingWalletChoice(address: string | null): void {
  choice = address;
  emit();
  (address ? SecureStore.setItemAsync(KEY, address) : SecureStore.deleteItemAsync(KEY)).catch(() => undefined);
}

export const getTradingWalletChoice = (): string | null => choice;

export function useTradingWalletChoice(): string | null {
  return useSyncExternalStore(subscribe, getTradingWalletChoice, getTradingWalletChoice);
}

/**
 * The address the next real trade spends from: the remembered pick while the server still lists it
 * as verified, else the first verified wallet, else none (the Profile offers Connect).
 */
export function pickTradingWallet(verified: readonly string[], pick: string | null): string | null {
  if (pick && verified.includes(pick)) return pick;
  return verified[0] ?? null;
}
