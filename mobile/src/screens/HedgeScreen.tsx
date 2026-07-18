// Hedge — phase 2, S1 + S2 in one scroll. Native adaptation of src/app/screens/HedgeScreen.tsx
// (the S1 wallet-hedge surface) plus the S2 life-hedge surface (spec §2): structured league → team
// pickers (PRIMARY) and free-text search (SECONDARY), with the discovery fallback ALWAYS labeled
// "Discovery — not a hedge" and never framed as a hedge. S2 works WITHOUT a linked wallet — it is
// never gated behind S1. Accepting creates a standard paper Bet server-side (the server re-derives
// everything from the suggestionId — this client never sends market/side/stake); we render the
// RETURNED stakeCents, which may be clamped to free Cash. 402 → the shared TopupSheet, exactly
// like the deck's 402 path. Telemetry: ONE impression per suggestionId per screen mount (deduped
// here; the server is idempotent per (user, suggestion, event) anyway).
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type {
  HedgeAcceptResponse,
  HedgePickerLeague,
  HedgePickersResponse,
  HedgeSearchResponse,
  HedgeSuggestion,
  HedgeSuggestionsResponse,
  HedgeWalletResponse,
  HedgeWalletStateResponse,
  MeResponse,
} from "../../lib/api-types";
import { statusOf, type Api } from "../api";
import { colors } from "../theme";
import { HedgeCard, type AcceptedInfo } from "../components/HedgeCard";
import { BASE58_RE, ExposurePanel, WalletForm, WalletIntro, type LinkError } from "../components/HedgeWallet";

type LoadError = "unavailable" | "generic";
type SearchResult = { suggestions: HedgeSuggestion[]; isDiscovery: boolean; matchedEntity: string | null };

export function HedgeScreen({ me, api, onRefreshMe, onToast, onTopup }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
  onTopup: () => void; // open the shared TopupSheet when Cash can't cover a hedge stake
}) {
  // ── S1 (wallet hedge) ──
  const [suggestions, setSuggestions] = useState<HedgeSuggestion[] | null>(null); // null = loading
  const [walletLinked, setWalletLinked] = useState<boolean | null>(null); // null = first load hasn't answered
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [exposure, setExposure] = useState<HedgeWalletResponse | null>(null); // set by a wallet POST this session
  const [walletFormOpen, setWalletFormOpen] = useState(false); // "different wallet" inline form
  const [address, setAddress] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<LinkError | null>(null);
  // ── S2 (life hedge — never gated behind S1) ──
  const [leagues, setLeagues] = useState<HedgePickerLeague[] | null>(null); // null = loading
  const [pickersFailed, setPickersFailed] = useState(false);
  const [activeLeague, setActiveLeague] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  // ── shared card actions ──
  const [accepted, setAccepted] = useState<Map<string, AcceptedInfo>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set()); // in-flight accept/dismiss, for render

  // Latest-value ref so the accept callback stays identity-stable across /api/me refreshes.
  const meRef = useRef<MeResponse | null>(me);
  useEffect(() => { meRef.current = me; }, [me]);
  // In-flight guard (ref, so stable callbacks can read it) — `pending` above is its render mirror.
  const inFlight = useRef(new Set<string>());
  // One impression per suggestionId per SCREEN mount — the Set dies with the screen (nav unmounts
  // it), so revisiting the tab re-logs, but re-renders / card remounts within a visit never spam.
  const impressions = useRef(new Set<string>());
  // This session's dismissed suggestionIds — the server re-derives (and re-serves) dismissed
  // suggestions, so reloads/searches filter them out to keep a dismissal stable within the mount.
  const dismissed = useRef(new Set<string>());

  // F9 viewport-impression plumbing. `scrollAreaRef` wraps the ScrollView so we can read the viewport's
  // window bounds; each card registers a `check` fn in `impressionSubs`; on scroll / (re)layout we ask
  // every registered card to measure itself and fire its impression once it actually overlaps the
  // viewport. `viewport.bottom` starts at 0 so NOTHING counts as visible until the viewport is measured
  // (a below-the-fold card must never log an impression on mount — spec §5).
  const scrollAreaRef = useRef<View>(null);
  const viewport = useRef<{ top: number; bottom: number }>({ top: 0, bottom: 0 });
  const impressionSubs = useRef(new Set<() => void>());

  const remeasureViewport = useCallback(() => {
    scrollAreaRef.current?.measureInWindow((x, y, w, h) => {
      if (h > 0) viewport.current = { top: y, bottom: y + h };
      impressionSubs.current.forEach((fn) => fn()); // re-check every card against the fresh viewport
    });
  }, []);

  const onScroll = useCallback((_e: NativeSyntheticEvent<NativeScrollEvent>) => {
    impressionSubs.current.forEach((fn) => fn());
  }, []);

  // One shared, gently-ticked clock for all cards' countdowns + the exposure staleness stamp.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // ─── S1 loading ───
  const loadSuggestions = useCallback(async () => {
    try {
      const res = (await api("/api/hedge/suggestions")) as HedgeSuggestionsResponse;
      setWalletLinked(res.walletLinked);
      // The server re-derives suggestions deterministically and does NOT filter dismissed ones, so a
      // reload would resurrect a card the user just dismissed — hide this session's dismissals.
      setSuggestions(res.suggestions.filter((s) => !dismissed.current.has(s.suggestionId)));
      setLoadError(null);
    } catch (e) {
      // 502 = the cached snapshot lapsed and Helius/Jupiter are down — nothing to derive from.
      setLoadError(statusOf(e) === 502 ? "unavailable" : "generic");
      setSuggestions(null);
    }
  }, [api]);

  // Returning-user state (F18a): the CACHED exposure of the primary linked wallet (no external calls),
  // so a returning user sees their exposure panel + linked state immediately without re-pasting the
  // address. Best-effort — on any failure loadSuggestions still owns walletLinked and the paste form
  // stays reachable. Runs alongside loadSuggestions on mount (both set walletLinked; they agree).
  const loadWalletState = useCallback(async () => {
    try {
      const res = (await api("/api/hedge/wallet")) as HedgeWalletStateResponse;
      setWalletLinked(res.walletLinked);
      if (res.exposure) setExposure(res.exposure);
    } catch {
      /* non-fatal: loadSuggestions owns walletLinked; "different wallet" form stays reachable */
    }
  }, [api]);

  // First load on mount.
  useEffect(() => { void loadWalletState(); void loadSuggestions(); }, [loadWalletState, loadSuggestions]);

  // Measure the viewport once the first frame is laid out, so above-the-fold cards fire promptly.
  useEffect(() => {
    const raf = requestAnimationFrame(remeasureViewport);
    return () => cancelAnimationFrame(raf);
  }, [remeasureViewport]);

  // POST the wallet link (the Refresh button reuses it with the already-linked address). The server
  // validates, links (idempotent), builds/refreshes the cached snapshot, and returns the exposure
  // summary we render verbatim. Returns success so a caller without a visible form can toast instead.
  const fetchWallet = useCallback(
    async (addr: string): Promise<boolean> => {
      setLinkBusy(true);
      setLinkError(null);
      try {
        const res = (await api("/api/hedge/wallet", {
          method: "POST",
          body: JSON.stringify({ address: addr }),
        })) as HedgeWalletResponse;
        setExposure(res);
        setWalletLinked(true);
        setAddress("");
        setWalletFormOpen(false);
        await loadSuggestions(); // a (re)linked wallet can change the suggestion set
        return true;
      } catch (e) {
        const status = statusOf(e);
        setLinkError(status === 400 ? "invalid" : status === 502 ? "unavailable" : "generic");
        return false;
      } finally {
        setLinkBusy(false);
      }
    },
    [api, loadSuggestions],
  );

  const linkWallet = useCallback(() => {
    const addr = address.trim();
    if (!BASE58_RE.test(addr)) { setLinkError("invalid"); return; }
    void fetchWallet(addr);
  }, [address, fetchWallet]);

  // Refresh from the exposure panel — the form is closed, so a failure has no inline error to show:
  // surface it as a toast instead of failing silently.
  const refreshWallet = useCallback(() => {
    if (!exposure || linkBusy) return;
    void fetchWallet(exposure.address).then((ok) => {
      if (!ok) onToast("Couldn't refresh exposure — try again");
    });
  }, [exposure, linkBusy, fetchWallet, onToast]);

  const retryLoad = useCallback(() => { setLoadError(null); void loadSuggestions(); }, [loadSuggestions]);
  // Opening the form wipes any stale link error left by a previous attempt/refresh.
  const toggleWalletForm = useCallback(() => { setLinkError(null); setWalletFormOpen((v) => !v); }, []);

  // ─── S2 pickers + free-text search ───
  const loadPickers = useCallback(async () => {
    try {
      const res = (await api("/api/hedge/pickers")) as HedgePickersResponse;
      setLeagues(res.leagues);
      setPickersFailed(false);
      // Keep the active league if it still exists; else fall to the first one.
      setActiveLeague((cur) => (cur && res.leagues.some((l) => l.slug === cur) ? cur : (res.leagues[0]?.slug ?? null)));
    } catch (e) {
      console.error(e);
      // Non-fatal: free-text search below still works without the picker lists.
      setLeagues([]);
      setPickersFailed(true);
    }
  }, [api]);

  useEffect(() => { void loadPickers(); }, [loadPickers]);

  // The SECONDARY S2 UX: free text → server-side alias/FTS (+ NLU edge below threshold) → S2
  // against-suggestions, or the honestly-labeled discovery fallback. Team-chip taps funnel through
  // the same path (a picked team is an exact-match search, so a pick always resolves to a live hedge).
  const runSearch = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || searchBusy) return;
      setSearchBusy(true);
      setSearchError(null);
      try {
        const res = (await api("/api/hedge/search", {
          method: "POST",
          body: JSON.stringify({ text }),
        })) as HedgeSearchResponse;
        setSearchResult({
          suggestions: res.suggestions.filter((s) => !dismissed.current.has(s.suggestionId)),
          isDiscovery: res.isDiscovery,
          matchedEntity: res.matchedEntity,
        });
      } catch (e) {
        const status = statusOf(e);
        setSearchError(status === 429
          ? "Slow down — give it a moment and try again."
          : "Search went sideways — try again.");
        if (status !== 429 && status !== 400) console.error(e);
      } finally {
        setSearchBusy(false);
      }
    },
    [api, searchBusy],
  );

  const submitSearch = useCallback(() => { void runSearch(searchText); }, [runSearch, searchText]);

  // ─── shared card actions (S1 + S2 suggestions accept/dismiss through the same endpoints) ───

  // Telemetry: impression fires once per suggestionId per screen mount (deduped here; the server is
  // idempotent per (user, suggestion, event) anyway). Best-effort — 404 just means the card went stale.
  const fireImpression = useCallback(
    (suggestionId: string) => {
      if (impressions.current.has(suggestionId)) return;
      impressions.current.add(suggestionId);
      api("/api/hedge/event", { method: "POST", body: JSON.stringify({ suggestionId, event: "impression" }) })
        .catch(() => { /* telemetry never blocks the UI */ });
    },
    [api],
  );

  const beginPending = useCallback((id: string) => {
    inFlight.current.add(id);
    setPending((prev) => new Set(prev).add(id));
  }, []);
  const endPending = useCallback((id: string) => {
    inFlight.current.delete(id);
    setPending((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }, []);

  // Accept → a standard paper Bet server-side. The server re-derives the suggestion from the id and
  // may clamp the stake to available Cash — we render the RETURNED stakeCents, never the proposal.
  const accept = useCallback(
    (s: HedgeSuggestion) => {
      if (inFlight.current.has(s.suggestionId)) return;
      const m = meRef.current;
      if (m && m.cashCents <= 0) { onToast("No free cash — top up to keep going"); onTopup(); return; }
      beginPending(s.suggestionId);
      // D9: OPTIMISTIC — flip the card to an accepted "placing…" state on this tick; the gesture never
      // blocks on the network. The POST below reconciles to server truth (success → returned stake;
      // any failure → roll the entry back out of the map + a non-blocking retry toast).
      setAccepted((prev) => new Map(prev).set(s.suggestionId, { stakeCents: s.proposedStakeCents, already: false, placing: true }));
      api("/api/hedge/accept", { method: "POST", body: JSON.stringify({ suggestionId: s.suggestionId }) })
        .then((r) => {
          const res = r as HedgeAcceptResponse;
          // Reconcile with the RETURNED stake (may be clamped to Cash — the banner says so) + already flag.
          setAccepted((prev) => new Map(prev).set(s.suggestionId, { stakeCents: res.stakeCents, already: res.alreadyAccepted, placing: false }));
          void onRefreshMe(); // the stake locks against Cash — repaint the HUD balance
        })
        .catch((e) => {
          // Roll the optimistic accept back to an actionable card — every failure (any 4xx, incl. a
          // backend out-of-band-price 409) is a clean non-blocking notice, never a stuck card.
          setAccepted((prev) => { const n = new Map(prev); n.delete(s.suggestionId); return n; });
          const status = statusOf(e);
          if (status === 402) { onToast("No free cash — top up to keep going"); onTopup(); }
          else if (status === 404 || status === 409) {
            // Stale/market-closed: drop the card wherever it lives and refresh the S1 list.
            onToast("That suggestion went stale — refreshing");
            dismissed.current.add(s.suggestionId);
            setSearchResult((prev) => prev
              ? { ...prev, suggestions: prev.suggestions.filter((x) => x.suggestionId !== s.suggestionId) }
              : prev);
            void loadSuggestions();
          } else {
            onToast("Couldn't place the hedge — try again");
            console.error(e);
          }
        })
        .finally(() => endPending(s.suggestionId));
    },
    [api, beginPending, endPending, loadSuggestions, onRefreshMe, onToast, onTopup],
  );

  // Dismiss → telemetry event + optimistic removal from BOTH lists (a card lives in exactly one, but
  // filtering both keeps the handler list-agnostic). 404 = the suggestion stopped deriving (stale);
  // the card is already gone locally, so there's nothing to roll back. The id also goes into the
  // session dismissed-set so the next reload/search doesn't resurrect it.
  const dismiss = useCallback(
    (s: HedgeSuggestion) => {
      if (inFlight.current.has(s.suggestionId)) return;
      beginPending(s.suggestionId);
      dismissed.current.add(s.suggestionId);
      setSuggestions((prev) => prev?.filter((x) => x.suggestionId !== s.suggestionId) ?? prev);
      setSearchResult((prev) => prev
        ? { ...prev, suggestions: prev.suggestions.filter((x) => x.suggestionId !== s.suggestionId) }
        : prev);
      api("/api/hedge/event", { method: "POST", body: JSON.stringify({ suggestionId: s.suggestionId, event: "dismiss" }) })
        .catch((e) => { if (statusOf(e) !== 404) console.error(e); })
        .finally(() => endPending(s.suggestionId));
    },
    [api, beginPending, endPending],
  );

  // F9: wrap each card in an ImpressionArea that fires the impression on first viewport overlap (not on
  // mount). HedgeCard itself no longer knows about impressions — the wrapper owns the timing.
  const renderCard = (s: HedgeSuggestion) => (
    <ImpressionArea
      key={s.suggestionId}
      id={s.suggestionId}
      onImpression={fireImpression}
      viewport={viewport}
      subs={impressionSubs}
    >
      <HedgeCard
        s={s}
        acceptedInfo={accepted.get(s.suggestionId)}
        busy={pending.has(s.suggestionId)}
        nowMs={nowMs}
        onAccept={accept}
        onDismiss={dismiss}
      />
    </ImpressionArea>
  );

  const activeTeams = leagues?.find((l) => l.slug === activeLeague)?.teams ?? [];

  return (
    <View style={styles.scrollArea} ref={scrollAreaRef} collapsable={false} onLayout={remeasureViewport}>
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      scrollEventThrottle={100}
    >
      <View style={styles.headerRow}>
        <Text style={styles.title}>🛡 Hedge</Text>
        <Text style={styles.subtitle}>Paper hedges for your bag & your team</Text>
      </View>

      {/* ─── S1 · wallet hedge ─── */}
      <Text style={styles.sectionLabel}>Wallet hedge</Text>
      {loadError ? (
        // Hoisted above the walletLinked branches: a FAILED first load leaves walletLinked null, and
        // the retry panel must stay reachable from there (and from a linked wallet's stale refresh).
        <View style={styles.notePanel}>
          <Text style={styles.noteText}>
            {loadError === "unavailable"
              ? "Price feeds are unreachable right now, so exposure can't be refreshed. Your wallet is safe — retry in a moment."
              : "Couldn't load your hedges. Give it another go."}
          </Text>
          <TouchableOpacity style={styles.retryBtn} onPress={retryLoad} accessibilityRole="button">
            <Text style={styles.retryText}>↻ Try again</Text>
          </TouchableOpacity>
        </View>
      ) : walletLinked === null ? (
        <View style={styles.centerNote}>
          <ActivityIndicator color={colors.energy} />
          <Text style={styles.noteText}>Reading your hedges…</Text>
        </View>
      ) : walletLinked === false ? (
        <WalletIntro address={address} busy={linkBusy} error={linkError} onAddress={setAddress} onSubmit={linkWallet} />
      ) : (
        <View>
          {exposure && (
            <ExposurePanel
              exposure={exposure}
              nowMs={nowMs}
              busy={linkBusy}
              onRefresh={refreshWallet}
              onToggleForm={toggleWalletForm}
              formOpen={walletFormOpen}
            />
          )}
          {/* The wallet is linked but wasn't (re)read this session — keep the manage affordance reachable. */}
          {!exposure && (
            <TouchableOpacity style={styles.diffWalletLink} onPress={toggleWalletForm} accessibilityRole="button">
              <Text style={styles.diffWalletText}>{walletFormOpen ? "Cancel" : "Link a different wallet"}</Text>
            </TouchableOpacity>
          )}
          {walletFormOpen && (
            <View style={styles.formPanel}>
              <WalletForm address={address} busy={linkBusy} error={linkError} onAddress={setAddress} onSubmit={linkWallet} />
            </View>
          )}

          {suggestions === null ? (
            <View style={styles.centerNote}>
              <ActivityIndicator color={colors.energy} />
              <Text style={styles.noteText}>Reading your hedges…</Text>
            </View>
          ) : suggestions.length === 0 ? (
            <View style={styles.notePanel}>
              <Text style={styles.emptyTitle}>No matching markets right now.</Text>
              <Text style={styles.noteText}>
                Your wallet&apos;s linked — when Polymarket lists a market that matches your bag, the hedge lands here.
              </Text>
            </View>
          ) : (
            <View style={styles.cardList}>{suggestions.map(renderCard)}</View>
          )}
        </View>
      )}

      {/* ─── S2 · life hedge (works WITHOUT a linked wallet — never gated behind S1) ─── */}
      <Text style={[styles.sectionLabel, { marginTop: 28 }]}>Life hedge</Text>
      <Text style={styles.sectionCopy}>
        Back a team? Bet AGAINST them here — if they break your heart, the pot softens it. No wallet needed.
      </Text>

      {leagues === null ? (
        <ActivityIndicator color={colors.energy} style={{ marginTop: 12 }} />
      ) : pickersFailed ? (
        <View style={styles.inlineNoteRow}>
          <Text style={[styles.inlineNote, { flex: 1 }]}>Couldn&apos;t load the team lists — type below instead.</Text>
          <TouchableOpacity onPress={() => void loadPickers()} accessibilityRole="button">
            <Text style={styles.inlineRetry}>↻ Retry</Text>
          </TouchableOpacity>
        </View>
      ) : leagues.length === 0 ? (
        <Text style={styles.inlineNote}>
          No open sports markets to pick from right now — type what you&apos;re worried about instead.
        </Text>
      ) : (
        <View style={{ marginTop: 10 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {leagues.map((l) => {
              const on = l.slug === activeLeague;
              return (
                <TouchableOpacity
                  key={l.slug}
                  style={[styles.chip, on && styles.chipOn]}
                  onPress={() => setActiveLeague(l.slug)}
                  accessibilityRole="button"
                  accessibilityLabel={l.label}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{l.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <View style={styles.teamChips}>
            {activeTeams.map((t) => (
              <TouchableOpacity
                key={t}
                style={styles.teamChip}
                onPress={() => void runSearch(t)}
                disabled={searchBusy}
                accessibilityRole="button"
                accessibilityLabel={t}
              >
                <Text style={styles.teamChipText}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <View style={styles.searchRow}>
        <TextInput
          value={searchText}
          onChangeText={setSearchText}
          onSubmitEditing={submitSearch}
          placeholder="Or type it — your club, a final, a trip…"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={200}
          editable={!searchBusy}
          accessibilityLabel="What are you worried about?"
          style={styles.searchInput}
        />
        <TouchableOpacity
          style={[styles.searchBtn, (!searchText.trim() || searchBusy) && { opacity: 0.5 }]}
          onPress={submitSearch}
          disabled={!searchText.trim() || searchBusy}
          accessibilityRole="button"
          accessibilityLabel="Search"
        >
          <Text style={styles.searchBtnText}>{searchBusy ? "…" : "Search"}</Text>
        </TouchableOpacity>
      </View>
      {searchError && <Text style={styles.searchError}>{searchError}</Text>}

      {searchBusy && <ActivityIndicator color={colors.energy} style={{ marginTop: 14 }} />}
      {searchResult && !searchBusy && (
        <View style={styles.cardList}>
          {searchResult.isDiscovery ? (
            // The fallback, honestly flagged (spec §2): zero hedge framing anywhere near these cards.
            <View style={styles.discoveryHeader}>
              <Text style={styles.discoveryTitle}>Discovery — not a hedge</Text>
              <Text style={styles.discoveryCopy}>
                Hard to hedge your unique situation — nothing matched a live market. Here are contested
                markets to explore instead; they are NOT hedges.
              </Text>
            </View>
          ) : (
            <View style={styles.resultHeader}>
              <Text style={styles.resultTitle}>
                Bets AGAINST <Text style={{ color: colors.text }}>{searchResult.matchedEntity}</Text>
              </Text>
              <Text style={styles.resultCopy}>You support them — these win if they lose.</Text>
            </View>
          )}
          {searchResult.suggestions.length === 0 ? (
            <Text style={styles.inlineNote}>Nothing live to show right now — try another team or wording.</Text>
          ) : (
            searchResult.suggestions.map(renderCard)
          )}
        </View>
      )}
    </ScrollView>
    </View>
  );
}

// F9: fires ONE impression the first time its wrapped card overlaps the viewport. Registers a `check`
// with the screen's subscriber set; the screen re-runs every check on scroll / (re)layout. `check` also
// runs on this view's own onLayout (covers cards that mount already on-screen). measureInWindow +
// `collapsable={false}` keeps the measurement reliable on Android. Fires once, then unsubscribes.
function ImpressionArea({
  id,
  onImpression,
  viewport,
  subs,
  children,
}: {
  id: string;
  onImpression: (id: string) => void;
  viewport: MutableRefObject<{ top: number; bottom: number }>;
  subs: MutableRefObject<Set<() => void>>;
  children: ReactNode;
}) {
  const ref = useRef<View>(null);
  const fired = useRef(false);
  // Once fired, `fired.current` makes every later invocation a cheap no-op (returns before measuring);
  // the effect below removes the subscription on unmount, so we never self-reference `check` to unsub.
  const check = useCallback(() => {
    if (fired.current) return;
    ref.current?.measureInWindow((x, y, w, h) => {
      if (fired.current) return;
      const vp = viewport.current;
      // real height + vertical overlap with the measured viewport band
      if (h > 0 && y < vp.bottom && y + h > vp.top) {
        fired.current = true;
        onImpression(id);
      }
    });
  }, [id, onImpression, viewport]);

  useEffect(() => {
    const s = subs.current;
    s.add(check);
    return () => { s.delete(check); };
  }, [check, subs]);

  return (
    <View ref={ref} collapsable={false} onLayout={check}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  scrollArea: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 24 },
  headerRow: { flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 4, flexWrap: "wrap" },
  title: { color: colors.text, fontSize: 26, fontWeight: "900" },
  subtitle: { fontSize: 11, color: colors.muted, flexShrink: 1 },
  sectionLabel: {
    marginTop: 16, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase",
    color: colors.muted, fontWeight: "700",
  },
  sectionCopy: { marginTop: 6, fontSize: 12, color: colors.muted, lineHeight: 18 },
  notePanel: {
    marginTop: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 18, padding: 16, alignItems: "center",
  },
  noteText: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 8 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "800", textAlign: "center" },
  retryBtn: {
    marginTop: 12, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 10, paddingHorizontal: 20,
  },
  retryText: { color: colors.energy, fontWeight: "700", fontSize: 13 },
  centerNote: { alignItems: "center", marginTop: 24 },
  diffWalletLink: { alignSelf: "flex-end", marginTop: 10, paddingVertical: 6, paddingHorizontal: 4 },
  diffWalletText: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  formPanel: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16, marginTop: 10,
  },
  cardList: { marginTop: 12, gap: 10 },
  inlineNoteRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  inlineNote: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 8 },
  inlineRetry: { color: colors.energy, fontSize: 11, fontWeight: "700" },
  chipRow: { gap: 8, paddingRight: 8 },
  chip: {
    paddingVertical: 7, paddingHorizontal: 13, borderRadius: 16,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
  },
  chipOn: { backgroundColor: "rgba(77,155,255,0.16)", borderColor: "rgba(77,155,255,0.5)" },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  chipTextOn: { color: colors.skip },
  teamChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  teamChip: {
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  teamChipText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  searchRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  searchInput: {
    flex: 1, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 14, color: colors.text, fontSize: 13,
  },
  searchBtn: {
    justifyContent: "center", paddingHorizontal: 16, borderRadius: 14,
    borderWidth: 1, borderColor: "rgba(255,61,205,0.5)", backgroundColor: "rgba(255,61,205,0.16)",
  },
  searchBtnText: { color: colors.energy, fontWeight: "700", fontSize: 13 },
  searchError: { color: colors.no, fontSize: 11, marginTop: 6, lineHeight: 16 },
  resultHeader: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, padding: 12,
  },
  resultTitle: { color: colors.skip, fontSize: 13, fontWeight: "800", letterSpacing: 0.3 },
  resultCopy: { color: colors.muted, fontSize: 11, marginTop: 3, lineHeight: 16 },
  discoveryHeader: {
    backgroundColor: "rgba(139,139,158,0.10)", borderWidth: 1, borderColor: "rgba(139,139,158,0.35)",
    borderRadius: 14, padding: 12,
  },
  discoveryTitle: { color: colors.muted, fontSize: 13, fontWeight: "800", letterSpacing: 0.3, textTransform: "uppercase" },
  discoveryCopy: { color: colors.muted, fontSize: 11, marginTop: 3, lineHeight: 16 },
});
