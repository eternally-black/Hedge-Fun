// Deck — the core loop. Native port of the deck half of src/app/page.tsx: a two-card stack with
// follow-the-finger swipes (right = YES / side A, left = NO / side B, up = SKIP), optimistic
// advance, preload-ahead refills, live freshness pruning, the 402 → top-up path, and the daily-cap
// hard stop. The economy stays server-owned — the client renders /api/me and never re-derives it.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { DeckCard as DeckCardT, DeckResponse, MeResponse, QuotesResponse } from "@contract/api-types";
import { priceMovedBp, statusOf, type Api } from "../api";
import { colors } from "../theme";
import { usd } from "../format";
import { useRealCtx } from "../useRealCtx";
import { placeRealOrder } from "@contract/real-client";
import { realErrText, realResultText, RETRYABLE_REAL_ERRORS } from "@contract/real-copy";
import { DECK_MIN_LEAD_MS, QUOTE_POLL_MS } from "../../lib/config";
import { CardPreview, DeckCard, isFresh, type SwipeDir } from "../components/DeckCard";
import { StakeSheet } from "../components/StakeSheet";

const REFILL_AT = 8; // preload-ahead threshold (same as web) — refill well before the deck runs dry

export function DeckScreen({ me, api, onRefreshMe, onToast, onTopup, realMode, onRealOrderDone, onOpenFeed, onCapHit }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
  onTopup: () => void;
  realMode: boolean;
  onRealOrderDone: () => void;
  onOpenFeed: () => void; // the cap panel's "Open the Feed →"
  onCapHit: () => void; // the last point swipe of the day — hand off to the feed (web page.tsx)
}) {
  const [deck, setDeck] = useState<DeckCardT[] | null>(null); // null = still loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [stakeOpen, setStakeOpen] = useState(false); // the STAKE chip's sheet (real mode only)
  const [nonce, setNonce] = useState(0); // bump to retry a failed load
  const topping = useRef(false); // dedupe: one refill fetch in flight
  // Latest `me` mirrored into a ref so the stable act() reads CURRENT cash/stake without churning
  // identity on every /api/me refresh (same pattern as web page.tsx).
  const meRef = useRef<MeResponse | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);
  const { ctx: realCtx } = useRealCtx(me);
  // Refs so act() keeps a stable identity across /api/me refreshes, same reason as meRef.
  const realCtxRef = useRef(realCtx);
  useEffect(() => { realCtxRef.current = realCtx; }, [realCtx]);
  const realModeRef = useRef(realMode);
  useEffect(() => { realModeRef.current = realMode; }, [realMode]);

  // Initial load (and retry). NOT re-run after swipes — /api/deck re-shuffles with a fresh seed
  // each call, so replacing the deck mid-session would snap a DIFFERENT card into the top slot.
  useEffect(() => {
    let alive = true;
    api("/api/deck")
      .then((d) => { if (alive) { setDeck((d as DeckResponse).cards); setLoadFailed(false); } })
      .catch((e) => { if (alive) { console.error(e); setLoadFailed(true); } });
    return () => { alive = false; };
  }, [api, nonce]);

  // Preload-ahead: append fresh cards (deduped by id) once the buffer drops to REFILL_AT.
  const topUpIfLow = useCallback(
    async (remaining: number) => {
      if (remaining > REFILL_AT || topping.current) return;
      topping.current = true;
      try {
        const d = (await api("/api/deck")) as DeckResponse;
        setDeck((cur) => {
          const have = new Set((cur ?? []).map((c) => c.id));
          return [...(cur ?? []), ...d.cards.filter((c) => !have.has(c.id))];
        });
      } catch (e) {
        console.error(e);
      } finally {
        topping.current = false;
      }
    },
    [api],
  );

  // Live freshness prune: drop cards that aged within the lead buffer so the top never decays to
  // ⏱ -> 0:00 — the next fresh card rises in its place, and a drained deck triggers a refill.
  useEffect(() => {
    const id = setInterval(() => {
      setDeck((d) => {
        if (!d) return d;
        const now = Date.now();
        const fresh = d.filter((c) => isFresh(c, now, DECK_MIN_LEAD_MS));
        if (fresh.length === d.length) return d;
        void topUpIfLow(fresh.length);
        return fresh;
      });
    }, 5000);
    return () => clearInterval(id);
  }, [topUpIfLow]);

  // Live quote on the TOP card (D10 Slice B). A CLOB book churns roughly every 5s, so the price a
  // card was dealt with goes stale while the user deliberates — which is exactly the moment that
  // matters. Only the card they can act on is polled: a next-up card's price is irrelevant until it
  // surfaces, and it gets a live quote the moment it does (this effect re-arms on topId). Paused
  // while the app is backgrounded — no radio spend on a deck nobody is looking at — and re-polled
  // immediately on return, so a resumed session re-syncs before any swipe can land.
  const topId = deck?.[0]?.id;
  useEffect(() => {
    if (!topId) return;
    let alive = true;
    const poll = async () => {
      if (AppState.currentState !== "active") return;
      // Cap spent -> the deck is hard-stopped and nothing is swipeable. Read from meRef so this
      // effect doesn't re-arm on every /api/me refresh and restart the cadence mid-deliberation.
      const m = meRef.current;
      if (!realModeRef.current && m && !m.dev && m.swipes.used >= m.swipes.cap) return;
      try {
        const r = (await api(`/api/quotes?ids=${encodeURIComponent(topId)}`)) as QuotesResponse;
        const q = r.quotes.find((x) => x.marketId === topId);
        if (!alive || !q || q.yesPriceBp == null || q.noPriceBp == null) return;
        // Patch in place — never reorder or drop, or the card would move under the thumb.
        setDeck((d) =>
          (d ?? []).map((c) =>
            c.id === topId && (c.yesPriceBp !== q.yesPriceBp || c.noPriceBp !== q.noPriceBp)
              ? { ...c, yesPriceBp: q.yesPriceBp!, noPriceBp: q.noPriceBp! }
              : c,
          ),
        );
      } catch {
        // A failed poll is a no-op: keep the last real price. The swipe re-quotes server-side and
        // the seen-vs-executed guard catches anything that drifted while we were blind.
      }
    };
    void poll();
    const id = setInterval(() => void poll(), QUOTE_POLL_MS);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void poll(); });
    return () => {
      alive = false;
      clearInterval(id);
      sub.remove();
    };
  }, [topId, api]);

  // Act on a card: YES/NO post a bet, SKIP posts to /api/skip (always free + unlimited). The
  // advance is OPTIMISTIC — the card flies out and the next rises in sync; the network call runs
  // behind. A 409 (already bet) is silent: the card was already gone, nothing to do.
  const act = useCallback(
    (card: DeckCardT, dir: SwipeDir) => {
      const advance = () =>
        setDeck((d) => {
          const now = Date.now();
          const next = (d ?? []).filter((c) => c.id !== card.id && isFresh(c, now, DECK_MIN_LEAD_MS));
          void topUpIfLow(next.length);
          return next;
        });
      // Cash gate: a YES/NO bet needs >= one stake of free Cash. Block BEFORE the optimistic
      // advance so the card isn't lost — it stays so the user can top up and retry. The sheet
      // opens right away: this IS the 402 path (a raced server 402 lands in the catch below).
      // Paper only: a real swipe spends the account's own real stake, not the play economy's cash.
      const m = meRef.current;
      if (!realModeRef.current && dir !== "SKIP" && m && m.cashCents < m.stakeCents) {
        onToast("No free cash left");
        onTopup();
        return;
      }
      // Real setup gate: without a deposit wallet there is nothing to sign an order with. The card
      // stays — nothing happened, so there is nothing to undo.
      if (realModeRef.current && dir !== "SKIP" && !realCtxRef.current?.depositWalletAddress) {
        onToast("Finish real-money setup in Profile first");
        return;
      }
      advance();
      // Echo the price the user was LOOKING AT for the side they picked, so the server can refuse
      // rather than silently book a worse one if the live book moved against them (D10 Slice B).
      // A YES/NO in real mode goes through the two-phase order protocol (intent → device signs →
      // submit → the device posts) instead of the paper ledger — the web's own client, verbatim.
      const req = dir === "SKIP"
        ? api("/api/skip", { method: "POST" })
        : realModeRef.current && realCtxRef.current
          ? placeRealOrder(api, realCtxRef.current, {
              marketId: card.id,
              side: dir,
              dir: "ENTRY",
              // The amount the card showed; the server only ever lowers it (min(explicit, stored)),
              // so a stale number here can never spend more than the account's current stake.
              stakeCents: meRef.current?.real.stakeCents,
              quotedPriceBp: dir === "YES" ? card.yesPriceBp : card.noPriceBp,
            }).then((r) => { onRealOrderDone(); return r as unknown; })
          : api("/api/swipe", {
              method: "POST",
              body: JSON.stringify({
                marketId: card.id,
                side: dir,
                quotedPriceBp: dir === "YES" ? card.yesPriceBp : card.noPriceBp,
              }),
            });
      req
        .then((r) => {
          void onRefreshMe(); // stats only (points/shards/balance/skip counter); never the deck
          // A real order that did not fully fill says so — "posted"/"submitting" are not a fill.
          if (dir !== "SKIP" && realModeRef.current) {
            const res = r as { status: string; filledSharesMicro?: string };
            if (res.status !== "filled") onToast(realResultText(res));
          }
          // Paper only: the swipe that spent the LAST point swipe of the day (count == cap, not over)
          // arms the one-shot hand-off to the feed. The server's own count is authoritative.
          if (dir !== "SKIP" && !realModeRef.current) {
            const resp = r as { overCap?: boolean; swipeCountToday?: number };
            const cap = meRef.current?.swipes.cap ?? 0;
            if (!resp.overCap && cap > 0 && (resp.swipeCountToday ?? 0) >= cap) onCapHit();
          }
        })
        .catch((e) => {
          const status = statusOf(e);
          const body = (e as { body?: { error?: string } }).body;
          const restore = () =>
            setDeck((d) => {
              const cur = d ?? [];
              return cur.some((c) => c.id === card.id) ? d : [card, ...cur]; // double-tap race
            });
          // Real refusals come before the paper chain below, which swallows every non-price_moved
          // 409 — and approvals_required is exactly the 409 the user must be told about. Nothing was
          // signed or spent, so the card comes back.
          if (status === 409 && body?.error === "approvals_required") {
            restore();
            onToast("Activate trading in Profile first");
          }
          // price_moved keeps its own branch below in both economies (the card returns at the fresh
          // price). Any other real failure: a retryable code restores the card; the rest are
          // terminal for it. The toast always names the reason.
          else if (realModeRef.current && dir !== "SKIP" && priceMovedBp(e) === undefined) {
            if (body?.error && RETRYABLE_REAL_ERRORS.has(body.error)) restore();
            onToast(realErrText(e));
            void onRefreshMe();
          }
          // 403 = daily swipe cap (raced the client gate). The bet wasn't stored; refreshMe pulls
          // used>=cap, which flips capReached below and shows the hard stop.
          if (status === 403) { onToast("Daily limit reached — back at 00:00 UTC"); void onRefreshMe(); }
          // 402 = no free cash (we pre-gate, so this is a race). The swipe rolled back server-side,
          // so the market re-enters a future deck — the card isn't lost. Skips never 402.
          else if (status === 402) { onToast("No free cash left"); onTopup(); void onRefreshMe(); }
          else if (status === 409) {
            // price_moved = the book moved against the user between the quote they saw and the lock.
            // Nothing was stored, so UNDO the optimistic advance: restore the card on top at the
            // FRESH price and let them decide again honestly. Any other 409 (already bet / expired /
            // untradable) is terminal and the card stays gone, exactly as before.
            const fresh = priceMovedBp(e);
            if (fresh !== undefined) {
              setDeck((d) => {
                const cur = d ?? [];
                if (cur.some((c) => c.id === card.id)) return d; // already restored (double-tap race)
                const restored: DeckCardT = dir === "YES"
                  ? { ...card, yesPriceBp: fresh }
                  : { ...card, noPriceBp: fresh };
                return [restored, ...cur];
              });
              onToast("Price moved — swipe again to confirm");
            }
          }
          else console.error(e);
        });
    },
    [api, onRefreshMe, onToast, onTopup, onRealOrderDone, onCapHit, topUpIfLow],
  );

  // Stable handler for the keyed DeckCard — reads the current top via a ref (kept in sync after
  // commit) so the card isn't handed a new function identity each render.
  const topRef = useRef<DeckCardT | undefined>(undefined);
  useEffect(() => { topRef.current = deck?.[0]; }, [deck]);
  const handleCommit = useCallback((dir: SwipeDir) => { if (topRef.current) act(topRef.current, dir); }, [act]);

  const retry = useCallback(() => { setDeck(null); setLoadFailed(false); setNonce((n) => n + 1); }, []);

  const top = deck?.[0];
  const next = deck?.[1];
  // Hard daily cap: once a non-dev user hits the swipe cap, the deck hard-stops until 00:00 UTC.
  // Paper only — the point-swipe cap is the play economy's, and says nothing about real money.
  // The equipped card design (Vault) — "classic" until /api/me lands.
  const skinId = me?.skins.equipped ?? "classic";
  const capReached = !realMode && !!me && !me.dev && me.swipes.used >= me.swipes.cap;

  return (
    <View style={styles.wrap}>
      <View style={styles.stack}>
        {capReached ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Deck&apos;s done.</Text>
            <Text style={styles.panelBody}>
              You spent today&apos;s {me?.swipes.cap} point swipes. Fresh deck at 00:00 UTC — meanwhile, the feed never sleeps.
            </Text>
            <TouchableOpacity style={styles.feedBtn} onPress={onOpenFeed} accessibilityRole="button">
              <Text style={styles.feedBtnText}>Open the Feed →</Text>
            </TouchableOpacity>
            <Text style={styles.panelFoot}>No points here — but shards still drop on every win.</Text>
          </View>
        ) : (
          <>
            {/* next card — FULLY rendered behind the top one (not a gray stub) */}
            {next && <CardPreview key={next.id} card={next} skinId={skinId} />}
            {top ? (
              <DeckCard
                key={top.id}
                card={top}
                skinId={skinId}
                // Display fallback only before the first /api/me lands — the server charges the
                // real stake regardless (POST /api/swipe carries no amount).
                // A real swipe spends the account's own real stake, not the play economy's.
                stakeCents={realMode ? (me?.real.stakeCents ?? 100) : (me?.stakeCents ?? 1000)}
                enabled
                onCommit={handleCommit}
                // Paper stake is a game rule, not a setting — only the real one is editable (web too).
                onEditStake={realMode ? () => setStakeOpen(true) : undefined}
              />
            ) : loadFailed ? (
              <View style={styles.panel}>
                <Text style={styles.panelBody}>Couldn&apos;t load the deck.</Text>
                <TouchableOpacity style={styles.retryBtn} onPress={retry}>
                  <Text style={styles.retryText}>↻ Retry</Text>
                </TouchableOpacity>
              </View>
            ) : deck === null ? (
              <View style={styles.panel}>
                <ActivityIndicator color={colors.energy} />
              </View>
            ) : (
              <View style={styles.panel}>
                <Text style={styles.panelBody}>No more cards right now. Check back after the next batch resolves.</Text>
              </View>
            )}
          </>
        )}
      </View>

      {/* fallback buttons — hidden once the daily cap is reached */}
      {!capReached && (
        <>
          <View style={styles.btnRow}>
            <CircleBtn glyph="✕" color={colors.no} size={56} disabled={!top} onPress={() => top && act(top, "NO")} />
            <CircleBtn glyph="↑" color={colors.skip} size={46} disabled={!top} onPress={() => top && act(top, "SKIP")} />
            <CircleBtn glyph="✓" color={colors.yes} size={56} disabled={!top} onPress={() => top && act(top, "YES")} />
          </View>
          <Text style={styles.skipNote}>
            {realMode
              ? `Real money · ${usd(me?.real.stakeCents ?? 0)} per call · skip is free`
              : "Skip free — save your swipes for the calls you want"}
          </Text>
        </>
      )}

      <StakeSheet
        visible={stakeOpen && !!me}
        stakeCents={me?.real.stakeCents ?? 100}
        minCents={me?.real.minStakeCents ?? 100}
        maxCents={me?.real.maxStakeCents ?? 100}
        api={api}
        onClose={() => setStakeOpen(false)}
        onSaved={onRefreshMe}
        onToast={onToast}
      />
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
  panelTitle: { color: colors.text, fontSize: 34, fontWeight: "900", marginBottom: 10 },
  panelBody: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  panelFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 10 },
  feedBtn: { marginTop: 16, paddingVertical: 12, paddingHorizontal: 22, borderRadius: 16, backgroundColor: colors.energy },
  feedBtnText: { color: "#06070a", fontSize: 15, fontWeight: "800", letterSpacing: 0.3 },
  retryBtn: {
    marginTop: 16, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 22,
  },
  retryText: { color: colors.energy, fontWeight: "700", fontSize: 14 },
  btnRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, paddingTop: 14, paddingBottom: 2 },
  circleBtn: { backgroundColor: colors.panel, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  skipNote: { textAlign: "center", fontSize: 10, color: colors.muted, paddingBottom: 8, paddingTop: 6 },
});
