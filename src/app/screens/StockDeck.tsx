"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StockDeckCard, StockCardPreview } from "../StockCard";
import { StockConsentSheet } from "./StockConsentSheet";
import { useBuyReal } from "../useBuyReal";
import { type Me } from "../ui";
import { STOCK_STAKE_PRESETS_CENTS } from "@/lib/config";
import type { StockDeckCard as StockDeckCardType, StockDeckResponse } from "@/lib/api-types";
import type { SwipeAction } from "../DeckCard";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export type DeckMode = "stocks" | "predictions";

// The two-segment pill that switches which deck occupies the slot. Centred above the card area, so
// the choice sits where the card is — not buried in a settings screen.
export function DeckModePill({ mode, onMode }: { mode: DeckMode; onMode: (m: DeckMode) => void }) {
  const seg = (m: DeckMode, label: string) => {
    const active = mode === m;
    return (
      <button
        type="button"
        onClick={() => onMode(m)}
        style={{
          margin: 0,
          font: "inherit",
          flex: 1,
          height: 32,
          borderRadius: 16,
          border: "none",
          background: active ? "var(--energy)" : "transparent",
          color: active ? "#06070a" : "var(--muted)",
          fontWeight: 800,
          fontSize: 12,
          letterSpacing: ".02em",
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "8px 14px 0" }}>
      <div style={{ display: "flex", width: 220, height: 32, borderRadius: 16, background: "var(--panel)", border: "1px solid var(--line)", padding: 0 }}>
        {seg("stocks", "Stocks")}
        {seg("predictions", "Predictions")}
      </div>
    </div>
  );
}

// ============================================================================
// StockDeck — the tokenized-stock deck. Same slot, same gesture, same physics as the prediction
// deck; a different card and a different economy. Right = buy (paper from the virtual balance, or
// real through the user's own Phantom), left = pass (never dealt again), up = skip (session only).
// ============================================================================
export function StockDeck({ api, me, onRefreshMe, onToast, mode, onMode }: {
  api: Api;
  me: Me | null;
  onRefreshMe: () => void | Promise<void>;
  onToast: (m: string) => void;
  mode: DeckMode;
  onMode: (m: DeckMode) => void;
}) {
  const [cards, setCards] = useState<StockDeckCardType[]>([]);
  const [stakeCents, setStakeCents] = useState<number>(STOCK_STAKE_PRESETS_CENTS[0]);
  const [wallets, setWallets] = useState<string[]>([]);
  const [stockConsent, setStockConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  // Every card id this session has already put in front of the user. Same rationale as the
  // prediction deck's `served`: a passed card is gone from the deck, so dedupe-by-deck would let the
  // server hand it straight back.
  const served = useRef<Set<string>>(new Set());
  const topping = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = (await api("/api/stocks/deck")) as StockDeckResponse;
      setCards(r.cards.filter((c) => !served.current.has(c.id)));
      for (const c of r.cards) served.current.add(c.id);
      setWallets(r.wallets);
      setStockConsent(r.stockConsent);
    } catch (e) {
      console.error(e);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  // Preload-ahead: refill well before the deck runs dry, so a fresh card is always buffered behind
  // the current one. `topping` dedupes so only one fetch is in flight.
  const topUpIfLow = useCallback(
    async (remaining: number) => {
      if (remaining > 8 || topping.current) return;
      topping.current = true;
      try {
        const r = (await api("/api/stocks/deck")) as StockDeckResponse;
        setCards((cur) => [...cur, ...r.cards.filter((c) => !served.current.has(c.id))]);
        for (const c of r.cards) served.current.add(c.id);
        setWallets(r.wallets);
        setStockConsent(r.stockConsent);
      } catch (e) {
        console.error(e);
      } finally {
        topping.current = false;
      }
    },
    [api],
  );

  const top = cards[0];
  const next = cards[1];

  // Advance the top card off the deck. Shared by every action and by the real-buy completion.
  const advanceTop = useCallback(() => {
    setCards((d) => {
      const nextDeck = d.slice(1);
      void topUpIfLow(nextDeck.length);
      return nextDeck;
    });
  }, [topUpIfLow]);

  const act = useCallback(
    (card: StockDeckCardType, dir: SwipeAction) => {
      if (dir === "SKIP") {
        // Session-local: a skip is "not now", not "never again". Never posted — the server has no
        // skip route for stocks, and a reload may legitimately re-serve it.
        advanceTop();
        return;
      }
      if (dir === "NO") {
        advanceTop();
        void api("/api/stocks/pass", { method: "POST", body: JSON.stringify({ assetId: card.id }) }).catch(() => { /* best-effort */ });
        return;
      }
      // YES = a paper buy. The cash gate is checked BEFORE the optimistic advance so the card is not
      // lost — it stays so the user can top up and retry.
      if (me && me.cashCents < stakeCents) {
        onToast("No free cash left");
        return;
      }
      advanceTop();
      setBusy(true); // one buy in flight at a time — the next card waits for this one's answer
      void api("/api/stocks/buy", {
        method: "POST",
        body: JSON.stringify({ assetId: card.id, stakeCents, requestId: crypto.randomUUID() }),
      })
        .then(() => { void onRefreshMe(); })
        .catch((e) => {
          const status = (e as { status?: number }).status;
          const code = (e as { body?: { error?: string } }).body?.error;
          if (status === 402) {
            setCards((d) => (d.some((c) => c.id === card.id) ? d : [card, ...d]));
            onToast("No free cash left");
          } else if (status === 502) {
            setCards((d) => (d.some((c) => c.id === card.id) ? d : [card, ...d]));
            onToast("Price unavailable — try again");
          } else if (status === 409) {
            onToast(code === "asset_halted" ? "Trading is halted for this stock" : code === "stake_too_small" ? "That stake is too small" : "Couldn't buy that one");
          } else {
            console.error(e);
          }
          void onRefreshMe();
        })
        .finally(() => setBusy(false));
    },
    [advanceTop, api, me, onRefreshMe, onToast, stakeCents],
  );

  const real = useBuyReal({
    api,
    me,
    onToast,
    onDone: () => { advanceTop(); void onRefreshMe(); },
  });

  // A consent accepted through the sheet flips the local flag immediately, so the card's buy button
  // stops saying "Accept xStocks terms to buy" without waiting for the next deck fetch.
  const acceptConsent = useCallback(async () => {
    await real.acceptConsent();
    setStockConsent(true);
  }, [real]);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <DeckModePill mode={mode} onMode={onMode} />

      <div style={{ position: "relative", flex: 1, margin: "6px 14px 0" }}>
        {next && <StockCardPreview key={next.id} card={next} stakeCents={stakeCents} />}
        {top ? (
          <StockDeckCard
            key={top.id}
            card={top}
            busy={busy}
            onAction={(a) => act(top, a)}
            stakeCents={stakeCents}
            onPickStake={setStakeCents}
            onBuyReal={() => void real.buyReal({ assetId: top.id, symbol: top.symbol }, stakeCents, { wallets, stockConsent })}
            walletLinked={wallets.length > 0}
            consented={stockConsent}
          />
        ) : (
          <div style={{ position: "absolute", inset: 0, borderRadius: 26, background: "var(--panel)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
            <p style={{ color: "var(--muted)" }}>You&apos;ve seen every stock in the deck — check your Portfolio.</p>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, padding: "14px 0 2px" }}>
        <CircleBtn glyph="✕" label="Pass" color="var(--no)" size={56} disabled={busy || !top} onClick={() => top && act(top, "NO")} />
        <CircleBtn glyph="↑" label="Skip" color="var(--skip)" size={46} disabled={busy || !top} onClick={() => top && act(top, "SKIP")} />
        <CircleBtn glyph="✓" label="Buy" color="var(--yes)" size={56} disabled={busy || !top} onClick={() => top && act(top, "YES")} />
      </div>
      <div style={{ textAlign: "center", fontSize: 10, color: "var(--muted)", paddingBottom: 8 }}>
        Paper buys use play money · Buy on Solana uses your own wallet
      </div>

      <StockConsentSheet open={real.consentOpen} busy={real.busy} onAccept={acceptConsent} onClose={real.closeConsent} />
    </div>
  );
}

// Local copy of page.tsx's CircleBtn — it is not exported, and the two decks must render identical
// controls. Same reset, same sizing, same disabled treatment.
function CircleBtn({ glyph, label, color, size, disabled, onClick }: { glyph: string; label: string; color: string; size: number; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        padding: 0, margin: 0, font: "inherit",
        width: size, height: size, borderRadius: "50%", background: "var(--panel)",
        border: `1.5px solid color-mix(in srgb,${color} 55%,var(--line))`, display: "flex",
        alignItems: "center", justifyContent: "center", cursor: disabled ? "default" : "pointer",
        color, fontSize: size > 50 ? 25 : 20, fontWeight: 800, opacity: disabled ? 0.5 : 1,
      }}
    >
      {glyph}
    </button>
  );
}
