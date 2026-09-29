// The phone's stock pocket — the twin of the stock wallet the web's page.tsx owns and polls, so the
// HUD and the Wallet sheet state the same number. The balance is stored WITH the address it was read
// for: a wallet switch does not make the old number stale, it makes it someone else's money, so a
// mismatch renders "—" until the new read lands (TradingWallet's reasoning).
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { MeResponse, StockWalletResponse } from "@contract/api-types";
import { type Api, statusOf } from "./api";
import * as wallet from "./platform/wallet.flavor";
import { pickTradingWallet, useTradingWalletChoice } from "./tradingWallet";

const POLL_MS = 30_000;

export function useStockPocket(me: MeResponse | null, api: Api, active: boolean): {
  address: string | null;
  usdCents: number | null;
  sponsored: boolean;
  refresh: () => Promise<void>;
} {
  const choice = useTradingWalletChoice();
  const address = pickTradingWallet(me?.stockWallets ?? [], choice);
  const [balance, setBalance] = useState<{ address: string; usdcCents: number } | null>(null);
  const [sponsored, setSponsored] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const read = useCallback(async (addr: string) => {
    try {
      const res = (await api(`/api/stocks/wallet?address=${encodeURIComponent(addr)}`)) as StockWalletResponse;
      if (!alive.current) return;
      setBalance({ address: res.address, usdcCents: res.usdcCents });
      setSponsored(res.sponsored);
    } catch (e) {
      // A read never toasts: a 403 wallet_not_verified or any other failure keeps the last number.
      console.log("stock pocket read failed", statusOf(e) ?? e);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    if (!address || !wallet.available) return;
    await read(address);
  }, [address, read]);

  // One read whenever the active wallet changes, then every 30 s while wanted and foregrounded, and
  // again the moment the app comes back to the foreground.
  useEffect(() => {
    if (!active || !wallet.available || !address) return;
    void read(address);
    const id = setInterval(() => {
      if (AppState.currentState === "active") void read(address);
    }, POLL_MS);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void read(address); });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [active, address, read]);

  const usdCents = balance && balance.address === address ? balance.usdcCents : null;
  return { address, usdCents, sponsored, refresh };
}
