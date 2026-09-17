// StockDeckScreen (native) — the tokenized-stock deck. Native twin of src/app/screens/StockDeck.tsx: same
// slot, same gesture, same physics as the prediction deck; a different card and a different economy.
// Right = buy, left = pass (never dealt again), up = skip (session only). WHOSE money a buy spends is the
// app's one Paper/Real switch (me.real.mode), exactly as it is for predictions — the card has no second
// button to choose it.
//
// Two deliberate deviations from the web, both forced by the platform:
//   • No wallet-balance pocket on the phone yet, so there is no pre-check that opens the wallet — the
//     server answers insufficient_usdc and useBuyReal toasts it.
//   • No pending replay on the phone: the attempt carries the signature server-side, so a confirm lost
//     between send and book is recovered by the server sweep, not by the device.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { MeResponse, StockDeckCard as StockDeckCardT, StockDeckResponse } from "@contract/api-types";
import type { Api } from "../api";
import { colors } from "../theme";
import { useBuyReal } from "../useBuyReal";
import { useStockStake } from "../useStockStake";
import { StockConsentSheet } from "../components/StockConsentSheet";
import { StockDeckCard, StockCardPreview } from "../components/StockCard";
import * as wallet from "../platform/wallet.flavor";
import type { SwipeDir } from "../components/DeckCard";

const REFILL_AT = 8; // preload-ahead threshold (same as web) — refill well before the deck runs dry

export type DeckMode = "stocks" | "predictions";

// The two-segment pill that switches which deck occupies the slot. Centred above the card area, so
// the choice sits where the card is — not buried in a settings screen.
export function DeckModePill({ mode, onMode }: { mode: DeckMode; onMode: (m: DeckMode) => void }) {
  const seg = (m: DeckMode, label: string) => {
    const active = mode === m;
    return (
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => onMode(m)}
        style={[styles.pillSeg, active && styles.pillSegActive]}
      >
        <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
      </TouchableOpacity>
    );
  };
  return (
    <View style={styles.pillWrap}>
      <View style={styles.pill}>
        {seg("stocks", "Stocks")}
        {seg("predictions", "Predictions")}
      </View>
    </View>
  );
}

// ============================================================================
// StockDeckScreen — the tokenized-stock deck. The pill is NOT rendered here: Root renders it above
// whichever deck is active.
// ============================================================================
export function StockDeckScreen({ me, api, onRefreshMe, onToast, onNeedWallet }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
  onNeedWallet: () => void;
}) {
  const [cards, setCards] = useState<StockDeckCardT[] | null>(null); // null = still loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to retry a failed load
  // Not local state: the amount the user picked here is the amount the portfolio's Buy button spends
  // too, and it outlives the mount (the deck unmounts every time they look at anything else).
  const { stakeCents, setStakeCents } = useStockStake();
  const [wallets, setWallets] = useState<string[]>([]);
  const [stockConsent, setStockConsent] = useState(false);
  // The server holds a fee-payer: real buys are gasless, so the footer can promise it.
  const [sponsored, setSponsored] = useState(false);
  const [busy, setBusy] = useState(false);
  // The server dealt nothing new on the last refill: stop asking until a card leaves the deck.
  const [exhausted, setExhausted] = useState(false);

  // Every card id this session has already put in front of the user. Same rationale as the
  // prediction deck's freshness prune: a passed card is gone from the deck, so dedupe-by-deck would
  // let the server hand it straight back.
  const served = useRef<Set<string>>(new Set());
  const topping = useRef(false);

  const load = useCallback(async () => {
    // Holds the refill guard for its whole flight: this IS a deck fetch, and the refill effect below
    // fires on mount (an empty deck is a low deck) — without this the first paint costs two.
    topping.current = true;
    try {
      const r = (await api("/api/stocks/deck")) as StockDeckResponse;
      setCards(r.cards.filter((c) => !served.current.has(c.id)));
      for (const c of r.cards) served.current.add(c.id);
      setWallets(r.wallets);
      setStockConsent(r.stockConsent);
      setSponsored(r.sponsored);
      setLoadFailed(false);
    } catch (e) {
      console.error(e);
      setLoadFailed(true);
    } finally {
      topping.current = false;
    }
  }, [api]);

  useEffect(() => { void load(); }, [load, nonce]);

  // Which economy a swipe-right spends. ONE switch for the whole app (me.real.mode, flipped on the
  // You screen) — the stock deck does not get a second one.
  // A build with no wallet (Play flavor) is paper on this screen whatever the account's mode says:
  // the server still deals the account's deck, but nothing here may render or spend real money.
  const realMode = wallet.available && me?.real.mode === "REAL";
  // The server deals a different deck per economy (real mode = on-chain assets only), so a flip
  // while this deck is mounted re-deals from scratch: served is cleared because it is a new deal,
  // not the tail of the old one. The first deal above is already dealt for the right economy (the
  // server reads the mode), so only a CHANGE re-deals — never the arrival of /api/me itself.
  const lastMode = useRef<boolean | null>(null);
  const hasMe = me !== null;
  useEffect(() => {
    if (!hasMe) return;
    if (lastMode.current !== null && lastMode.current !== realMode) {
      served.current.clear();
      setExhausted(false);
      void load();
    }
    lastMode.current = realMode;
  }, [hasMe, load, realMode]);

  // Preload-ahead: refill well before the deck runs dry, so a fresh card is always buffered behind
  // the current one. `topping` dedupes so only one fetch is in flight.
  const topUpIfLow = useCallback(
    async (remaining: number) => {
      if (remaining > REFILL_AT || topping.current || exhausted) return;
      topping.current = true;
      try {
        const r = (await api("/api/stocks/deck")) as StockDeckResponse;
        // Decide what is new BEFORE touching `served` (a state updater must stay pure), and leave the
        // array untouched when nothing is: a fresh identity for the same cards would re-fire the
        // count-driven refill below and fetch in a loop while the server has ≤ REFILL_AT cards left.
        const fresh = r.cards.filter((c) => !served.current.has(c.id));
        for (const c of r.cards) served.current.add(c.id);
        if (fresh.length === 0) setExhausted(true);
        else setCards((cur) => [...(cur ?? []), ...fresh]);
        setWallets(r.wallets);
        setStockConsent(r.stockConsent);
        setSponsored(r.sponsored);
      } catch (e) {
        console.error(e);
      } finally {
        topping.current = false;
      }
    },
    [api, exhausted],
  );

  const top = cards?.[0];
  const next = cards?.[1];

  // Remove ONE card, by id. Deliberately not "drop the top one": a real buy finishes minutes after
  // the tap, by which time the user may have skipped past it — advancing the top then would throw
  // away a card they never acted on. A card already gone (skipped, passed) is a no-op.
  const removeCard = useCallback((id: string) => {
    setCards((d) => (d ?? []).filter((c) => c.id !== id));
    setExhausted(false); // a card left — the server may have something new by now
  }, []);

  // The refill is driven by the deck's LENGTH, not fired from inside the updater above: a state
  // updater must be pure (React is free to call it twice), and a fetch in there is a second deck
  // request on every removal in StrictMode.
  const count = cards?.length ?? -1; // -1 = not loaded yet
  useEffect(() => { if (count >= 0) void topUpIfLow(count); }, [count, topUpIfLow]);

  // The card a real buy was started on. A REAL buy is a wallet signature plus a chain confirmation —
  // seconds to minutes — so which card it belongs to has to be remembered, not re-derived on done.
  const buyingId = useRef<string | null>(null);

  // Memoized rather than inlined into the call below: an arrow here is a new onDone every render,
  // which rebuilds useBuyReal's callbacks, which rebuilds the card's props (rerender-memo).
  const onDone = useCallback(() => {
    const id = buyingId.current;
    buyingId.current = null;
    if (id) removeCard(id);
    void onRefreshMe();
  }, [onRefreshMe, removeCard]);

  const real = useBuyReal({
    api,
    me,
    onToast,
    onNeedWallet,
    onRefreshMe,
    ctx: { wallets, stockConsent, sponsored },
    onDone,
  });
  const { buyReal, acceptConsent: acceptConsentReal } = real;

  const act = useCallback(
    (card: StockDeckCardT, dir: SwipeDir) => {
      if (dir === "SKIP") {
        // Session-local: a skip is "not now", not "never again". Never posted — the server has no
        // skip route for stocks, and a reload may legitimately re-serve it.
        removeCard(card.id);
        return;
      }
      if (dir === "NO") {
        removeCard(card.id);
        void api("/api/stocks/pass", { method: "POST", body: JSON.stringify({ assetId: card.id }) }).catch(() => { /* best-effort */ });
        return;
      }
      // YES = buy, in whichever economy the app is in — the card has no second button to choose it.
      if (realMode && card.tradable) {
        // NOT removed here: only /confirm says a real buy happened, and onDone removes the card it
        // was started on — minutes later, by which time the top card may be a different one.
        buyingId.current = card.id;
        void buyReal({ assetId: card.id, symbol: card.symbol }, stakeCents, { wallets, stockConsent, sponsored });
        return;
      }
      // A paper buy. The cash gate is checked BEFORE the optimistic advance so the card is not
      // lost — it stays so the user can top up and retry.
      if (me && me.cashCents < stakeCents) {
        onToast("No free cash left");
        return;
      }
      removeCard(card.id);
      setBusy(true); // one buy in flight at a time — the next card waits for this one's answer
      void api("/api/stocks/buy", {
        method: "POST",
        body: JSON.stringify({ assetId: card.id, stakeCents, requestId: randomUUID() }),
      })
        .then(() => { void onRefreshMe(); })
        .catch((e) => {
          const status = (e as { status?: number }).status;
          const code = (e as { body?: { error?: string } }).body?.error;
          if (status === 402) {
            setCards((d) => ((d ?? []).some((c) => c.id === card.id) ? d : [card, ...(d ?? [])]));
            onToast("No free cash left");
          } else if (status === 502) {
            setCards((d) => ((d ?? []).some((c) => c.id === card.id) ? d : [card, ...(d ?? [])]));
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
    [api, buyReal, me, onRefreshMe, onToast, realMode, removeCard, sponsored, stakeCents, stockConsent, wallets],
  );

  // A consent accepted through the sheet flips the local flag immediately, so the next swipe does
  // not re-open it while the deck fetch catches up — but only if the SERVER recorded it. Flipping it
  // on a failed POST lets /real/tx 403 again, which reopens this same sheet: a loop with no way out.
  const acceptConsent = useCallback(async () => {
    if (await acceptConsentReal()) setStockConsent(true);
  }, [acceptConsentReal]);

  // Stable card callbacks: StockCardFace is memo()'d, and a fresh closure per render defeats it.
  const onAction = useCallback((a: SwipeDir) => { if (top) act(top, a); }, [act, top]);

  // A real buy locks the deck the same way a paper one does — harder, in fact: real money is moving,
  // and every action here (pass, skip, paper buy, swipe) changes which card is on top.
  const locked = busy || real.busy;

  const retry = useCallback(() => { setCards(null); setLoadFailed(false); setNonce((n) => n + 1); }, []);

  return (
    <View style={styles.wrap}>
      <View style={styles.stack}>
        {next && <StockCardPreview key={next.id} card={next} stakeCents={stakeCents} realMode={realMode} />}
        {top ? (
          <StockDeckCard
            key={top.id}
            card={top}
            busy={locked}
            onAction={onAction}
            stakeCents={stakeCents}
            onPickStake={setStakeCents}
            realMode={realMode}
          />
        ) : loadFailed ? (
          <View style={styles.panel}>
            <Text style={styles.panelBody}>Couldn&apos;t load the deck.</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={retry}>
              <Text style={styles.retryText}>↻ Retry</Text>
            </TouchableOpacity>
          </View>
        ) : cards === null ? (
          <View style={styles.panel}>
            <ActivityIndicator color={colors.energy} />
          </View>
        ) : (
          <View style={styles.panel}>
            <Text style={styles.panelBody}>You&apos;ve seen every stock in the deck — check your Portfolio.</Text>
          </View>
        )}
      </View>

      <View style={styles.btnRow}>
        <CircleBtn glyph="✕" color={colors.no} size={56} disabled={locked || !top} onPress={() => top && act(top, "NO")} />
        <CircleBtn glyph="↑" color={colors.skip} size={46} disabled={locked || !top} onPress={() => top && act(top, "SKIP")} />
        <CircleBtn glyph="✓" color={colors.yes} size={56} disabled={locked || !top} onPress={() => top && act(top, "YES")} />
      </View>
      <Text style={styles.footerNote}>
        {realMode
          ? sponsored
            ? "Real money · fees on us"
            : "Real money · from your wallet"
          : "Paper buys use play money · switch to real money in Profile"}
      </Text>

      <StockConsentSheet open={real.consentOpen} busy={real.busy} sponsored={sponsored} onAccept={acceptConsent} onClose={real.closeConsent} />
    </View>
  );
}

function CircleBtn({ glyph, color, size, disabled, onPress }: {
  glyph: string;
  color: string;
  size: number;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.circleBtn,
        { width: size, height: size, borderRadius: size / 2, borderColor: color },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text style={{ color, fontSize: size > 50 ? 25 : 20, fontWeight: "800" }}>{glyph}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  stack: { flex: 1, marginTop: 6, marginHorizontal: 14 },
  panel: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 26, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    alignItems: "center", justifyContent: "center", padding: 28,
  },
  panelBody: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  retryBtn: {
    marginTop: 16, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 22,
  },
  retryText: { color: colors.energy, fontWeight: "700", fontSize: 14 },
  btnRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, paddingTop: 14, paddingBottom: 2 },
  circleBtn: { backgroundColor: colors.panel, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  footerNote: { textAlign: "center", fontSize: 10, color: colors.muted, paddingBottom: 8, paddingTop: 6 },
  pillWrap: { alignItems: "center", paddingTop: 8, paddingHorizontal: 14 },
  pill: {
    flexDirection: "row", width: 220, height: 32, borderRadius: 16,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
  },
  pillSeg: { flex: 1, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  pillSegActive: { backgroundColor: colors.energy },
  pillText: { color: colors.muted, fontWeight: "800", fontSize: 12, letterSpacing: 0.2 },
  pillTextActive: { color: "#06070a" },
});
