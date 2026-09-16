"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REAL_BALANCE_POLL_MS } from "@/lib/config";
import type { StockWalletResponse } from "@/lib/api-types";
import { isWalletUnverified, useEnsureVerified } from "./useTradingWallet";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The REAL · STOCKS pocket: what the user's own Solana wallet holds, in cents. One owner (page.tsx),
// so the HUD chip, the deck CTA and the wallet sheet all state the SAME number — the whole point of
// naming pockets is that two surfaces never disagree about which money they mean.
//
// null = not known yet (no wallet, first load, or the read failed). Never 0: "$0.00" is a claim, and
// claiming an empty wallet that is merely unread is how a funded user gets told to go fund it.
export function useStockWallet(api: Api, address: string | null, active: boolean): {
  usdCents: number | null;
  refresh: () => Promise<void>;
  unverified: boolean;
} {
  // The balance is stored WITH the address it was read for. A wallet switch does not make the old
  // number stale, it makes it someone else's money — so a mismatch reads as "not known yet" during
  // render (calculate-derived-state), rather than being cleared by an effect that would paint the
  // previous wallet's balance for one frame first.
  const [last, setLast] = useState<{ address: string; usdCents: number } | null>(null);
  const [unverified, setUnverified] = useState(false);
  const ensureVerified = useEnsureVerified(api);
  const usdCents = last && last.address === address ? last.usdCents : null;

  // Four things ask for a read (the interval, a tab return, a window focus, a manual refresh) and
  // their answers land in whatever order the network decides. Only the LATEST issued read may write:
  // an older answer winning is how a user who just deposited sees the pre-deposit number again.
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; // set on mount too — StrictMode's simulated unmount runs the cleanup
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    const mine = ++seq.current;
    const current = () => mounted.current && seq.current === mine;
    const read = async () => {
      const r = (await api(`/api/stocks/wallet?address=${address}`)) as StockWalletResponse;
      if (!current()) return;
      setLast({ address, usdCents: r.usdcCents });
      setUnverified(false);
    };
    try {
      await read();
    } catch (e) {
      // /stocks/wallet answers only for a VERIFIED address, and a freshly created embedded wallet is
      // not one until we tell the server about it — this read is usually the first thing that needs it.
      const status = (e as { status?: number }).status;
      const code = (e as { body?: { error?: string } }).body?.error;
      if (status !== 403 || code !== "wallet_not_verified") return console.error(e);
      try {
        await ensureVerified(address);
        await read();
      } catch (e2) {
        // Said in state, not in a toast: this runs on a poll, and a Privy outage would otherwise
        // repeat the same toast every REAL_BALANCE_POLL_MS until it cleared.
        if (!current()) return;
        if (isWalletUnverified(e2)) setUnverified(true);
        else console.error(e2);
      }
    }
  }, [address, api, ensureVerified]);

  // Visibility-gated poll — the same rule as every other balance in the app: a hidden tab is an RPC
  // read for a number nobody is looking at, and coming back re-reads immediately, which is exactly
  // the moment someone returns from the wallet or exchange they just sent USDC from.
  useEffect(() => {
    if (!active || !address) return;
    let timer: number | undefined;
    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      timer = window.setInterval(() => void refresh(), REAL_BALANCE_POLL_MS);
    };
    // Returning to the tab fires visibilitychange AND focus, and a desktop window switch fires only
    // focus — so both are listened to and the pair is collapsed to ONE read by the last-wake stamp.
    let lastWake = 0;
    const onWake = () => {
      if (document.hidden) return stop();
      const now = Date.now();
      if (now - lastWake > 1000) {
        lastWake = now;
        void refresh();
      }
      start();
    };
    // "We are visible now" is the mount case too — read once, then start the clock. Going through
    // onWake rather than calling refresh() here keeps the first setState off the effect body.
    onWake();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [active, address, refresh]);

  return { usdCents, refresh, unverified };
}
