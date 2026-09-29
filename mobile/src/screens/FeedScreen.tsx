// FeedScreen (native) — port of src/app/screens/FeedScreen.tsx. The post-cap feed: a vertical paging
// list of near-50% binary markets (crypto-first), cursor-paginated for infinite scroll. Tap a side to
// bet: the same paper stake as a swipe, but POST /api/feed/bet earns NO points (shards still accrue,
// uncapped). One card fills the viewport (pagingEnabled + a measured item height), like the web's
// scroll-snap.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, type LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import type { BetSide, DeckCard, FeedResponse, MeResponse } from "@contract/api-types";
import { colors } from "../theme";
import type { Api } from "../api";
import { MarketCard, useMarketBet } from "../components/MarketCard";

// Max pages one loadMore() skips through when the server hands back an empty page with a non-null
// cursor (a quality-filtered dead zone). Bounds the loop so it can never run away.
const MAX_SKIP_PAGES = 8;

export function FeedScreen({ api, me, onRefreshMe, onToast, onTopup }: {
  api: Api;
  me: MeResponse | null;
  onRefreshMe: () => void;
  onToast: (msg: string) => void;
  onTopup: () => void; // open the wallet sheet when Cash can't cover a stake
}) {
  const [items, setItems] = useState<DeckCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const { placed, placeBet } = useMarketBet({ api, me, onRefreshMe, onToast, onTopup });
  // One shared, gently-ticked clock for every card's countdown — 15 s is plenty for a scroll feed.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Refs keep loadMore stable while still reading the latest values.
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const cursorRef = useRef<string | null>(null);
  // Every card id already appended — dedupe against this, not against a possibly stale list.
  const seen = useRef(new Set<string>());

  // Fetch the next page(s): loop past empty-but-not-done pages until something is appended or the
  // pool is dry, bounded by MAX_SKIP_PAGES; in-flight guarded so repeated end-reached events can't
  // double-fetch.
  const loadMore = useCallback(async () => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      for (let i = 0; i < MAX_SKIP_PAGES; i++) {
        const cursor = cursorRef.current;
        const res = (await api(`/api/feed${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)) as FeedResponse;
        cursorRef.current = res.nextCursor;
        const fresh = res.cards.filter((c) => !seen.current.has(c.id));
        for (const c of fresh) seen.current.add(c.id);
        if (fresh.length) setItems((prev) => [...prev, ...fresh]);
        if (res.nextCursor === null) { doneRef.current = true; setDone(true); break; }
        if (fresh.length > 0) break;
      }
    } catch (e) {
      console.error(e);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [api]);

  // First page on mount — an empty list never fires onEndReached.
  useEffect(() => { void loadMore(); }, [loadMore]);

  const [itemH, setItemH] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setItemH(h);
  }, []);
  const stakeCents = me?.stakeCents ?? 1000;

  const renderItem = useCallback(
    ({ item }: { item: DeckCard }) => (
      <FeedCard card={item} placedSide={placed.get(item.id)} nowMs={nowMs} stakeCents={stakeCents} onBet={placeBet} height={itemH} />
    ),
    [placed, nowMs, stakeCents, placeBet, itemH],
  );

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {items.length === 0 ? (
        <View style={styles.empty}>
          {loading ? (
            <ActivityIndicator color={colors.energy} />
          ) : (
            <Text style={styles.emptyText}>
              {done ? "No feed markets right now. Check back after the next batch resolves." : "Loading the feed…"}
            </Text>
          )}
        </View>
      ) : itemH > 0 ? (
        <FlatList
          data={items}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          getItemLayout={(_, index) => ({ length: itemH, offset: itemH * index, index })}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.6}
          ListFooterComponent={loading ? <Text style={styles.more}>Loading more…</Text> : null}
        />
      ) : null}
    </View>
  );
}

// One viewport-tall page wrapping the shared MarketCard; memoized so a bet on another card never
// re-renders this one.
const FeedCard = memo(function FeedCard({ card, placedSide, nowMs, stakeCents, onBet, height }: {
  card: DeckCard;
  placedSide: BetSide | undefined;
  nowMs: number;
  stakeCents: number;
  onBet: (card: DeckCard, side: BetSide) => void;
  height: number;
}) {
  return (
    <View style={[styles.section, { height }]}>
      <MarketCard card={card} placedSide={placedSide} nowMs={nowMs} stakeCents={stakeCents} onBet={onBet} />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  section: { paddingVertical: 6, paddingHorizontal: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  emptyText: { color: colors.muted, fontSize: 14, textAlign: "center" },
  more: { paddingVertical: 16, textAlign: "center", fontSize: 11, color: colors.muted },
});
