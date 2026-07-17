// Deck — the core loop. Native port of the deck half of src/app/page.tsx: a two-card stack with
// follow-the-finger swipes (right = YES / side A, left = NO / side B, up = SKIP), optimistic
// advance, preload-ahead refills, live freshness pruning, the 402 → top-up path, and the daily-cap
// hard stop. The economy stays server-owned — the client renders /api/me and never re-derives it.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { DeckCard as DeckCardT, DeckResponse, MeResponse } from "../../lib/api-types";
import { statusOf, type Api } from "../api";
import { colors } from "../theme";
import { DECK_MIN_LEAD_MS } from "../../lib/config";
import { CardPreview, DeckCard, isFresh, type SwipeDir } from "../components/DeckCard";

const REFILL_AT = 8; // preload-ahead threshold (same as web) — refill well before the deck runs dry

export function DeckScreen({ me, api, onRefreshMe, onToast, onTopup }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
  onTopup: () => void;
}) {
  const [deck, setDeck] = useState<DeckCardT[] | null>(null); // null = still loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to retry a failed load
  const topping = useRef(false); // dedupe: one refill fetch in flight
  // Latest `me` mirrored into a ref so the stable act() reads CURRENT cash/stake without churning
  // identity on every /api/me refresh (same pattern as web page.tsx).
  const meRef = useRef<MeResponse | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);

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
      const m = meRef.current;
      if (dir !== "SKIP" && m && m.cashCents < m.stakeCents) {
        onToast("No free cash left");
        onTopup();
        return;
      }
      advance();
      const req = dir === "SKIP"
        ? api("/api/skip", { method: "POST" })
        : api("/api/swipe", { method: "POST", body: JSON.stringify({ marketId: card.id, side: dir }) });
      req
        .then(() => {
          void onRefreshMe(); // stats only (points/shards/balance/skip counter); never the deck
        })
        .catch((e) => {
          const status = statusOf(e);
          // 403 = daily swipe cap (raced the client gate). The bet wasn't stored; refreshMe pulls
          // used>=cap, which flips capReached below and shows the hard stop.
          if (status === 403) { onToast("Daily limit reached — back at 00:00 UTC"); void onRefreshMe(); }
          // 402 = no free cash (we pre-gate, so this is a race). The swipe rolled back server-side,
          // so the market re-enters a future deck — the card isn't lost. Skips never 402.
          else if (status === 402) { onToast("No free cash left"); onTopup(); void onRefreshMe(); }
          else if (status !== 409) console.error(e);
        });
    },
    [api, onRefreshMe, onToast, onTopup, topUpIfLow],
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
  const capReached = !!me && !me.dev && me.swipes.used >= me.swipes.cap;

  return (
    <View style={styles.wrap}>
      <View style={styles.stack}>
        {capReached ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Deck&apos;s done.</Text>
            <Text style={styles.panelBody}>
              You spent today&apos;s {me?.swipes.cap} point swipes. Fresh deck at 00:00 UTC — settled calls land in Results as markets resolve.
            </Text>
          </View>
        ) : (
          <>
            {/* next card — FULLY rendered behind the top one (not a gray stub) */}
            {next && <CardPreview key={next.id} card={next} />}
            {top ? (
              <DeckCard
                key={top.id}
                card={top}
                // Display fallback only before the first /api/me lands — the server charges the
                // real stake regardless (POST /api/swipe carries no amount).
                stakeCents={me?.stakeCents ?? 1000}
                enabled
                onCommit={handleCommit}
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
          <Text style={styles.skipNote}>Skip free — save your swipes for the calls you want</Text>
        </>
      )}
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
  retryBtn: {
    marginTop: 16, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 22,
  },
  retryText: { color: colors.energy, fontWeight: "700", fontSize: 14 },
  btnRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, paddingTop: 14, paddingBottom: 2 },
  circleBtn: { backgroundColor: colors.panel, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  skipNote: { textAlign: "center", fontSize: 10, color: colors.muted, paddingBottom: 8, paddingTop: 6 },
});
