"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  type Me,
  bgGrad,
  catOf,
  cents,
  countdown,
  displayQuestion,
  sideLabels,
  usd,
  winPayout,
} from "../ui";
import type {
  HedgeAcceptResponse,
  HedgePickerLeague,
  HedgePickersResponse,
  HedgeSearchResponse,
  HedgeSuggestion,
  HedgeSuggestionsResponse,
  HedgeWalletResponse,
  HedgeWalletStateResponse,
} from "@/lib/api-types";

// Whatever useApi resolves to — a thrown error carries `.status` (mirrors page.tsx's catch blocks).
type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// `placing` = the D9 optimistic state: the tap flipped the card to accepted instantly and the POST is
// still in flight. Success reconciles to the server-returned stakeCents/already; any failure rolls the
// entry back out of the map (card returns to actionable) + a non-blocking retry toast.
type AcceptedInfo = { stakeCents: number; already: boolean; placing: boolean };
type LinkError = "invalid" | "unavailable" | "generic";
type LoadError = "unavailable" | "generic";

// Light client-side sanity check ONLY — the server does the real validation (isAddress). Base58
// alphabet (no 0/O/I/l), 32–44 chars covers a 32-byte Solana address.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const LINK_ERROR_COPY: Record<LinkError, string> = {
  invalid: "That doesn't look like a Solana address — check for typos and paste it again.",
  unavailable:
    "Balances/prices are unreachable right now (upstream outage). The address is saved — hit retry in a moment to read its exposure.",
  generic: "Something went sideways linking that wallet. Try again.",
};

// ============================================================================
// HedgeScreen — the S1 wallet-hedge surface (phase 2). Link a READ-ONLY Solana address, get
// deterministic paper-hedge suggestions matched to what it holds: 5–10% of a major (SOL / BTC /
// ETH) against a matching Polymarket market, ~3% of the long tail into a SOL short as a LABELED
// proxy (basis risk). Accepting creates a standard paper Bet with the variable stake the server
// returns (it may clamp to available Cash — we render the returned number, never the proposal).
// All shapes come straight from src/lib/api-types.ts; the server re-derives everything from the
// suggestionId, so this client never sends market/side/stake.
// ============================================================================
export function HedgeScreen({
  api,
  onRefreshMe,
  onToast,
  onTopup,
}: {
  api: Api;
  me: Me | null; // kept in the contract (page.tsx passes it); accept no longer pre-gates on it — the
  // server's 402 is authoritative, so an already-accepted id can still replay for free at $0 Cash (F7).
  onRefreshMe: () => void;
  onToast: (msg: string) => void;
  onTopup: () => void; // open the BalanceSheet top-up when Cash can't cover a hedge stake
}) {
  const [suggestions, setSuggestions] = useState<HedgeSuggestion[] | null>(null); // null = loading
  const [walletLinked, setWalletLinked] = useState<boolean | null>(null); // null = first load hasn't answered
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [exposure, setExposure] = useState<HedgeWalletResponse | null>(null); // set by a wallet POST this session
  const [walletFormOpen, setWalletFormOpen] = useState(false); // "different wallet" inline form
  const [address, setAddress] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<LinkError | null>(null);
  const [accepted, setAccepted] = useState<Map<string, AcceptedInfo>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set()); // in-flight accept/dismiss, for render

  // In-flight guard (ref, so stable callbacks can read it) — `pending` above is its render mirror.
  const inFlight = useRef(new Set<string>());
  // One impression per suggestionId per SCREEN mount — the Set dies with the screen (nav unmounts
  // it), so revisiting the tab re-logs, but re-renders / card remounts within a visit never spam.
  const impressions = useRef(new Set<string>());
  // This session's dismissed suggestionIds — the server re-derives (and re-serves) dismissed
  // suggestions, so loadSuggestions filters them out to keep a dismissal stable within the mount.
  const dismissed = useRef(new Set<string>());

  // One shared, gently-ticked clock for all cards' countdowns (15s, like the feed — the deck ticks
  // per-second because it's a single focused card). Lazy init keeps Date.now() out of SSR render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const loadSuggestions = useCallback(async () => {
    try {
      const res = (await api("/api/hedge/suggestions")) as HedgeSuggestionsResponse;
      setWalletLinked(res.walletLinked);
      // The server re-derives suggestions deterministically and does NOT filter dismissed ones, so a
      // reload would resurrect a card the user just dismissed — hide this session's dismissals.
      setSuggestions(res.suggestions.filter((s) => !dismissed.current.has(s.suggestionId)));
      setLoadError(null);
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 502 = the cached snapshot lapsed and Helius/Jupiter are down — nothing to derive from.
      setLoadError(status === 502 ? "unavailable" : "generic");
      setSuggestions(null);
    }
  }, [api]);

  // Returning-user state (F18a): the CACHED exposure of the primary linked wallet (no external calls),
  // so a returning user sees their exposure panel + linked state immediately without re-pasting the
  // address. Best-effort — on any failure the suggestions load still owns walletLinked and the paste
  // form stays reachable. Runs alongside loadSuggestions on mount (both set walletLinked; they agree).
  const loadWalletState = useCallback(async () => {
    try {
      const res = (await api("/api/hedge/wallet")) as HedgeWalletStateResponse;
      setWalletLinked(res.walletLinked);
      if (res.exposure) setExposure(res.exposure);
    } catch {
      /* non-fatal: loadSuggestions owns walletLinked; "Different wallet" form stays reachable */
    }
  }, [api]);

  // First load on mount.
  useEffect(() => { void loadWalletState(); void loadSuggestions(); }, [loadWalletState, loadSuggestions]);

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
        const status = (e as { status?: number }).status;
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
  // `onStale` lets each surface own its stale-card cleanup: S1 reloads its deterministic list; the S2
  // surface (no persistent list to reload) just drops the card. Shared by S1 + S2/fallback ids.
  const accept = useCallback(
    (s: HedgeSuggestion, onStale?: (id: string) => void) => {
      if (inFlight.current.has(s.suggestionId)) return;
      beginPending(s.suggestionId);
      // D9: OPTIMISTIC — flip the card to an accepted "placing…" state on this tick; the gesture never
      // blocks on the network. The POST below reconciles to server truth. No client zero-Cash pre-gate
      // (F7): the server's 402 owns that, and dropping it lets an already-accepted id replay for free
      // (idempotent 200) even at $0 Cash — e.g. a re-tap after a mid-flight nav wiped this map.
      setAccepted((prev) => new Map(prev).set(s.suggestionId, { stakeCents: s.proposedStakeCents, already: false, placing: true }));
      api("/api/hedge/accept", { method: "POST", body: JSON.stringify({ suggestionId: s.suggestionId }) })
        .then((r) => {
          const res = r as HedgeAcceptResponse;
          // Reconcile with the RETURNED stake (may be clamped to Cash — the banner says so) + already flag.
          setAccepted((prev) => new Map(prev).set(s.suggestionId, { stakeCents: res.stakeCents, already: res.alreadyAccepted, placing: false }));
          onRefreshMe(); // the stake locks against Cash — repaint the HUD balance
        })
        .catch((e) => {
          // Roll the optimistic accept back to an actionable card; every failure is a non-blocking notice
          // (any 4xx — incl. a backend out-of-band-price 409 — lands on a clean toast, never a stuck card).
          setAccepted((prev) => { const n = new Map(prev); n.delete(s.suggestionId); return n; });
          const status = (e as { status?: number }).status;
          if (status === 402) { onToast("No free cash — top up to keep going"); onTopup(); }
          else if (status === 404 || status === 409) { onToast("That suggestion went stale — refreshing"); if (onStale) onStale(s.suggestionId); else void loadSuggestions(); }
          else { onToast("Couldn't place that bet — try again"); console.error(e); }
        })
        .finally(() => endPending(s.suggestionId));
    },
    [api, beginPending, endPending, loadSuggestions, onRefreshMe, onToast, onTopup],
  );

  // Dismiss → telemetry event + optimistic removal. 404 = the suggestion stopped deriving (stale);
  // the card is already gone locally, so there's nothing to roll back. The id also goes into the
  // session dismissed-set so the next reload doesn't resurrect it (see loadSuggestions; the S2
  // surface honors it too via isDismissed). `removeFromList` lets the S2 surface drop the card from
  // its own results list instead of the S1 list.
  const dismiss = useCallback(
    (s: HedgeSuggestion, removeFromList?: (id: string) => void) => {
      if (inFlight.current.has(s.suggestionId)) return;
      beginPending(s.suggestionId);
      dismissed.current.add(s.suggestionId);
      if (removeFromList) removeFromList(s.suggestionId);
      else setSuggestions((prev) => prev?.filter((x) => x.suggestionId !== s.suggestionId) ?? prev);
      api("/api/hedge/event", { method: "POST", body: JSON.stringify({ suggestionId: s.suggestionId, event: "dismiss" }) })
        .catch((e) => {
          const status = (e as { status?: number }).status;
          if (status !== 404) console.error(e);
        })
        .finally(() => endPending(s.suggestionId));
    },
    [api, beginPending, endPending],
  );

  // Whether an id was dismissed this session — the S2 surface filters freshly-fetched search results
  // through this so a just-dismissed card doesn't resurrect on a re-search (mirrors loadSuggestions).
  const isDismissed = useCallback((id: string) => dismissed.current.has(id), []);

  const retryLoad = useCallback(() => { setLoadError(null); void loadSuggestions(); }, [loadSuggestions]);
  // Opening the form wipes any stale link error left by a previous attempt/refresh.
  const toggleWalletForm = useCallback(() => { setLinkError(null); setWalletFormOpen((v) => !v); }, []);

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 20px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>🛡 Hedge</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Paper hedges for your Solana bag</div>
      </div>

      {loadError ? (
        // Hoisted above the walletLinked branches: a FAILED first load leaves walletLinked null, and
        // the retry panel must stay reachable from there (and from a linked wallet's stale refresh).
        <div style={{ textAlign: "center", marginTop: 60, padding: "0 24px" }}>
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
            {loadError === "unavailable"
              ? "Price feeds are unreachable right now, so exposure can't be refreshed. Your wallet is safe — retry in a moment."
              : "Couldn't load your hedges. Give it another go."}
          </p>
          <div style={{ marginTop: 12 }}>
            <GhostButton onClick={retryLoad}>↻ Try again</GhostButton>
          </div>
        </div>
      ) : walletLinked === null ? (
        <CenterNote>Reading your hedges…</CenterNote>
      ) : walletLinked === false ? (
        <WalletIntro address={address} busy={linkBusy} error={linkError} onAddress={setAddress} onSubmit={linkWallet} />
      ) : (
        <>
          {exposure && (
            <ExposurePanel exposure={exposure} nowMs={nowMs} busy={linkBusy} onRefresh={refreshWallet} onToggleForm={toggleWalletForm} formOpen={walletFormOpen} />
          )}
          {/* The wallet is linked but wasn't (re)read this session — keep the manage affordance reachable. */}
          {!exposure && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <GhostButton onClick={toggleWalletForm}>{walletFormOpen ? "Cancel" : "Link a different wallet"}</GhostButton>
            </div>
          )}
          {walletFormOpen && (
            <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "14px 16px", marginTop: 10 }}>
              <WalletForm address={address} busy={linkBusy} error={linkError} onAddress={setAddress} onSubmit={linkWallet} />
            </div>
          )}

          {suggestions === null ? (
            <CenterNote>Reading your hedges…</CenterNote>
          ) : suggestions.length === 0 ? (
            <div style={{ textAlign: "center", marginTop: 60, padding: "0 24px" }}>
              <div style={{ fontFamily: "var(--df)", fontSize: 22 }}>No matching markets right now.</div>
              <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
                Your wallet&apos;s linked — when Polymarket lists a market that matches your bag, the hedge lands here.
              </p>
            </div>
          ) : (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {suggestions.map((s) => (
                <HedgeCard
                  key={s.suggestionId}
                  s={s}
                  acceptedInfo={accepted.get(s.suggestionId)}
                  busy={pending.has(s.suggestionId)}
                  nowMs={nowMs}
                  onAccept={accept}
                  onDismiss={dismiss}
                  onImpression={fireImpression}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* S2 — the life-event surface. NOT gated on a linked wallet (it hits its own endpoints), so it
          renders in every S1 state above: intro, loading, linked, or an S1 feed outage. */}
      <LifeHedgeSection
        api={api}
        accepted={accepted}
        pending={pending}
        nowMs={nowMs}
        onAccept={accept}
        onDismiss={dismiss}
        onImpression={fireImpression}
        isDismissed={isDismissed}
      />
    </div>
  );
}

// ============================================================================
// LifeHedgeSection — the S2 (life-event) surface. Works WITHOUT a linked wallet: it hits its own
// endpoints (GET /api/hedge/pickers, POST /api/hedge/search) and reuses the shared accept / dismiss /
// impression machinery + HedgeCard. Pickers are PRIMARY (tap a league → team chips → a pick is a
// search for that team); free-text is SECONDARY; a discovery fallback (isDiscovery) is visually
// distinct and NEVER framed as a hedge (the server returns it when nothing matched).
// ============================================================================
type SearchState = "idle" | "loading" | "error" | "done";

function LifeHedgeSection({
  api,
  accepted,
  pending,
  nowMs,
  onAccept,
  onDismiss,
  onImpression,
  isDismissed,
}: {
  api: Api;
  accepted: Map<string, AcceptedInfo>;
  pending: ReadonlySet<string>;
  nowMs: number;
  onAccept: (s: HedgeSuggestion, onStale?: (id: string) => void) => void;
  onDismiss: (s: HedgeSuggestion, removeFromList?: (id: string) => void) => void;
  onImpression: (suggestionId: string) => void;
  isDismissed: (id: string) => boolean;
}) {
  const [pickers, setPickers] = useState<HedgePickerLeague[] | null>(null); // null = loading
  const [pickersError, setPickersError] = useState(false);
  const [openLeague, setOpenLeague] = useState<string | null>(null); // expanded league slug

  const [text, setText] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [results, setResults] = useState<HedgeSuggestion[] | null>(null); // null = no search this session
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [isDiscovery, setIsDiscovery] = useState(false);
  const [matchedEntity, setMatchedEntity] = useState<string | null>(null);
  // F8: monotonic request id — only the latest search may write results/header, so a slow earlier
  // response can't land under a newer query (e.g. tap "Lakers" then "Real Madrid" in quick succession).
  const searchSeq = useRef(0);

  const loadPickers = useCallback(async () => {
    setPickersError(false);
    try {
      const res = (await api("/api/hedge/pickers")) as HedgePickersResponse;
      setPickers(res.leagues);
    } catch {
      setPickers([]); // an empty list still routes the user to the free-text path
      setPickersError(true);
    }
  }, [api]);

  useEffect(() => { void loadPickers(); }, [loadPickers]);

  // A pick OR a free-text submit is ONE POST /api/hedge/search (the team name IS the query text).
  // Freshly-fetched results are filtered through isDismissed so a just-dismissed card can't resurrect.
  const runSearch = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      const seq = ++searchSeq.current; // claim this as the newest search
      setLastQuery(q);
      setSearchState("loading");
      try {
        const res = (await api("/api/hedge/search", { method: "POST", body: JSON.stringify({ text: q }) })) as HedgeSearchResponse;
        if (seq !== searchSeq.current) return; // a newer search superseded us — drop this stale response
        setResults(res.suggestions.filter((s) => !isDismissed(s.suggestionId)));
        setIsDiscovery(res.isDiscovery);
        setMatchedEntity(res.matchedEntity);
        setSearchState("done");
      } catch {
        if (seq !== searchSeq.current) return; // stale failure — the newer search owns the UI now
        setSearchState("error");
      }
    },
    [api, isDismissed],
  );

  const submitText = useCallback(() => { void runSearch(text); }, [runSearch, text]);
  const pickTeam = useCallback((team: string) => { setText(team); void runSearch(team); }, [runSearch]);

  // The S2 surface has no persistent list to reload, so dropping the card from results IS the cleanup
  // for both a dismiss and an accept that came back stale (404/409).
  const removeResult = useCallback((id: string) => {
    setResults((prev) => (prev ? prev.filter((s) => s.suggestionId !== id) : prev));
  }, []);
  const handleAccept = useCallback((s: HedgeSuggestion) => onAccept(s, removeResult), [onAccept, removeResult]);
  const handleDismiss = useCallback((s: HedgeSuggestion) => onDismiss(s, removeResult), [onDismiss, removeResult]);

  const leagues = pickers ?? [];
  const openTeams = openLeague ? leagues.find((l) => l.slug === openLeague)?.teams ?? [] : [];
  const noPickers = pickers !== null && leagues.length === 0;

  return (
    <div style={{ marginTop: 26 }}>
      {/* section divider + heading */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ height: 1, flex: 1, background: "var(--line)" }} />
        <div style={{ fontSize: 10, letterSpacing: ".16em", color: "var(--muted)", textTransform: "uppercase", fontWeight: 700 }}>Life hedge</div>
        <div style={{ height: 1, flex: 1, background: "var(--line)" }} />
      </div>
      <div style={{ fontFamily: "var(--df)", fontSize: 22, lineHeight: 1.06 }}>🎟 Bet against the outcome you dread</div>
      <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5, marginTop: 5 }}>
        Rooting for a team? Put a little on them losing — soften the sting either way. No wallet needed.
      </p>

      {/* pickers — the PRIMARY path */}
      <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "14px 16px", marginTop: 12 }}>
        {pickers === null ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading pick lists…</div>
        ) : noPickers ? (
          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
            {pickersError
              ? "Couldn't load the pick lists right now — you can still describe it below."
              : "No upcoming sports to pick from right now — describe who you're rooting for below."}
            {pickersError && (
              <div style={{ marginTop: 10 }}><GhostButton onClick={loadPickers}>↻ Try again</GhostButton></div>
            )}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 }}>Pick a league</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {leagues.map((l) => (
                <Chip key={l.slug} active={openLeague === l.slug} onClick={() => setOpenLeague((cur) => (cur === l.slug ? null : l.slug))}>
                  {l.label}
                </Chip>
              ))}
            </div>
            {openLeague && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 }}>Who are you rooting for?</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {openTeams.map((t) => (
                    <Chip key={t} accent onClick={() => pickTeam(t)}>{t}</Chip>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* free-text — the SECONDARY path */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase", marginBottom: 6 }}>Or describe it</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitText(); }}
            maxLength={200}
            placeholder="e.g. I'm rooting for the Lakers"
            aria-label="Describe who or what you're rooting for"
            style={{ flex: 1, minWidth: 0, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 14px", color: "var(--text)", fontFamily: "var(--nf)", fontSize: 12, outline: "none" }}
          />
          <button
            type="button"
            onClick={searchState === "loading" ? undefined : submitText}
            disabled={searchState === "loading" || !text.trim()}
            style={{ padding: "0 16px", borderRadius: 14, fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, cursor: searchState === "loading" || !text.trim() ? "default" : "pointer", border: "1px solid color-mix(in srgb,var(--energy) 50%,transparent)", background: "color-mix(in srgb,var(--energy) 16%,transparent)", color: "var(--energy)", opacity: searchState === "loading" || !text.trim() ? 0.5 : 1 }}
          >
            {searchState === "loading" ? "…" : "Find"}
          </button>
        </div>
      </div>

      {/* results */}
      {searchState === "loading" ? (
        <div style={{ textAlign: "center", marginTop: 18, color: "var(--muted)", fontSize: 12 }}>Finding markets…</div>
      ) : searchState === "error" ? (
        <div style={{ textAlign: "center", marginTop: 18, padding: "0 12px" }}>
          <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>Couldn&apos;t run that search. Give it another go.</p>
          <div style={{ marginTop: 10 }}><GhostButton onClick={() => void runSearch(lastQuery)}>↻ Try again</GhostButton></div>
        </div>
      ) : searchState === "done" && results ? (
        results.length === 0 ? (
          // Defensive: the API returns a discovery fallback instead of nothing, so an empty result set
          // is unreachable in practice — handled so a contract change never renders a blank surface.
          <div style={{ textAlign: "center", marginTop: 18, color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
            Nothing to bet on for that right now — try another team or event.
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {isDiscovery ? (
              // Discovery header (spec §2): honest, distinct, NOT a hedge. Each card also carries its
              // own "Discovery — not a hedge" badge (see HedgeCard).
              <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 14, border: "1px dashed color-mix(in srgb,var(--muted) 55%,transparent)", background: "color-mix(in srgb,var(--muted) 10%,transparent)" }}>
                <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.45 }}>
                  Nothing clean to hedge in your situation — but here are {results.length} markets you might like.
                </div>
                <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>Discovery picks, not hedges.</div>
              </div>
            ) : (
              <div style={{ marginBottom: 10, fontSize: 12, color: "var(--muted)" }}>
                Betting against <span style={{ color: "var(--text)", fontWeight: 700 }}>{matchedEntity ?? lastQuery}</span>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {results.map((s) => (
                <HedgeCard
                  key={s.suggestionId}
                  s={s}
                  acceptedInfo={accepted.get(s.suggestionId)}
                  busy={pending.has(s.suggestionId)}
                  nowMs={nowMs}
                  onAccept={handleAccept}
                  onDismiss={handleDismiss}
                  onImpression={onImpression}
                />
              ))}
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

// A tappable pill for the league / team pickers. `active` = the currently-expanded league; `accent` =
// a team chip (energy-tinted — the actionable "pick" that fires a search).
function Chip({ active, accent, onClick, children }: { active?: boolean; accent?: boolean; onClick: () => void; children: React.ReactNode }) {
  const idle = accent ? "var(--energy)" : "var(--text)";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "7px 12px", borderRadius: 999, font: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer",
        color: active ? "#0b0b12" : idle,
        background: active ? "var(--energy)" : accent ? "color-mix(in srgb,var(--energy) 14%,transparent)" : "var(--panel2)",
        border: `1px solid ${active ? "var(--energy)" : accent ? "color-mix(in srgb,var(--energy) 45%,transparent)" : "var(--line)"}`,
      }}
    >
      {children}
    </button>
  );
}

// ============================================================================
// HedgeCard — one suggestion in the deck/feed card visual language (gradient panel, category chip,
// ⏱ countdown, odds split) PLUS the hedge-specific chrome: kind badge (proxy carries a visible
// "proxy · basis risk" label — D3/spec §2), the hedged exposure line, the avg-buy-cost narrative
// (rendered ONLY when the server sends one — D4 degradation, no placeholder), and accept/dismiss
// in place of the two-sided bet buttons. Memoized on primitive-ish props like the feed cards.
// ============================================================================
const HedgeCard = memo(function HedgeCard({
  s,
  acceptedInfo,
  busy,
  nowMs,
  onAccept,
  onDismiss,
  onImpression,
}: {
  s: HedgeSuggestion;
  acceptedInfo: AcceptedInfo | undefined;
  busy: boolean;
  nowMs: number; // shared screen clock — keeps Date.now() out of render
  onAccept: (s: HedgeSuggestion) => void;
  onDismiss: (s: HedgeSuggestion) => void;
  onImpression: (suggestionId: string) => void;
}) {
  // F9: fire the impression on first VIEWPORT visibility, not mount — a below-the-fold card must not
  // log an impression until the user actually scrolls it into view (spec §5 honesty). One IO per card;
  // it disconnects after the first intersection, and the screen-level Set still dedupes across remounts.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    // Guard for SSR / very old browsers with no IntersectionObserver — fall back to a mount fire.
    if (typeof IntersectionObserver === "undefined") { onImpression(s.suggestionId); return; }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            onImpression(s.suggestionId);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.35 }, // "in view" = a meaningful slice of the card is on screen
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onImpression, s.suggestionId]);

  const cat = catOf(s);
  const labels = sideLabels(s);
  const cd = countdown(s.resolutionDeadline, nowMs);
  const sideColor = s.side === "YES" ? "var(--yes)" : "var(--no)";
  const sidePriceBp = s.side === "YES" ? s.yesPriceBp : s.noPriceBp;
  const payout = usd(winPayout(sidePriceBp, s.proposedStakeCents));

  // Kind drives the framing: S2 = "bets AGAINST the entity you support" (the returned side IS that
  // against-bet — we never re-derive it here); a discovery fallback is NOT a hedge and carries no
  // hedge framing at all. `foe` is the supported entity we're betting against (server-provided).
  // F13: a fallback card is discovery whether the server flags isDiscovery OR only tags kind:"fallback"
  // — either alone must never render as a plain "Direct hedge". Key every discovery branch off both.
  const discovery = s.isDiscovery === true || s.kind === "fallback";
  const isS2 = s.kind === "S2";
  const foe = s.matchedEntity && s.matchedEntity.trim() ? s.matchedEntity : "your side";
  const stake = usd(s.proposedStakeCents);
  const ctaLabel = discovery
    ? `Bet ${stake} on ${s.sideLabel}`
    : isS2
      ? `Bet ${stake} against ${foe}`
      : `Hedge ${stake} on ${s.sideLabel}`;
  const footnote = discovery
    ? "Discovery — a market you might like. Not a hedge, not sized to anything you hold."
    : isS2
      ? "Paper bet against your own side — a fixed stake, not hedge math."
      : s.isProxy
        ? "Proxy — shorts SOL, not your exact tokens. Basis risk · sizing is a product rule, not hedge math."
        : "Paper bet · sizing is a product rule, not hedge math.";

  return (
    <div ref={cardRef} style={{ position: "relative", borderRadius: 22, overflow: "hidden", background: "var(--panel2)", border: discovery ? "1px dashed color-mix(in srgb,var(--muted) 60%,transparent)" : "1px solid var(--line)", boxShadow: "0 18px 40px -20px rgba(0,0,0,.7)" }}>
      {/* Discovery cards drop the hedge-category gradient tint — a flat neutral panel keeps them from
          reading as a sized hedge, reinforcing the "not a hedge" badge. */}
      <div style={{ position: "absolute", inset: 0, background: discovery ? "linear-gradient(170deg, var(--panel2), var(--panel))" : bgGrad(cat.color) }} />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", padding: "14px 15px" }}>
        {/* kind badge + category (+ league on S2) + countdown */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <KindBadge s={s} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: cat.color, boxShadow: `0 0 8px ${cat.color}` }} />
            <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>{cat.label}</span>
          </div>
          {isS2 && s.league && s.league !== cat.label && (
            <div style={{ display: "flex", alignItems: "center", background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18 }}>
              <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: "var(--energy)" }}>{s.league}</span>
            </div>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18, border: `1px solid ${cd.urgent ? "color-mix(in srgb,var(--no) 60%,transparent)" : "transparent"}` }}>
            <span style={{ fontSize: 11 }}>⏱</span>
            <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 12, color: cd.urgent ? "var(--no)" : "#fff" }}>{cd.text}</span>
          </div>
        </div>

        {/* question + hedge context */}
        <div style={{ padding: "10px 0" }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 20, lineHeight: 1.08, letterSpacing: ".2px", color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,.5)" }}>{displayQuestion(s)}</div>
          {isS2 ? (
            // S2 framing: we bet AGAINST the entity the user supports. The side below IS that
            // against-bet (server-derived) — the copy names it, it never re-derives the side.
            <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,.78)" }}>
              Bets against <span style={{ fontWeight: 700, color: "#fff" }}>{foe}</span>
              <div style={{ marginTop: 2, fontSize: 11, color: "rgba(255,255,255,.6)" }}>
                You win if {foe} slip — the side below is that bet.
              </div>
            </div>
          ) : discovery ? (
            // Discovery: NO hedge framing anywhere — just an honest "you might like this" nudge.
            <div style={{ marginTop: 6, fontSize: 11.5, color: "rgba(255,255,255,.6)" }}>
              A contested market you might like.
            </div>
          ) : (
            <>
              <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,.75)" }}>
                Hedges your <span style={{ fontWeight: 700, color: "#fff" }}>{s.hedgedAsset}</span> · {usd(s.hedgedNotionalCents)} exposure
              </div>
              {/* D4 degradation: the avg-buy-cost line renders ONLY when the server sends one. */}
              {s.avgBuyCostNarrative && (
                <div style={{ marginTop: 3, fontSize: 11, color: "rgba(255,255,255,.6)" }}>{s.avgBuyCostNarrative}</div>
              )}
            </>
          )}
        </div>

        {/* odds split — same visual language as the deck/feed cards */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 12, marginBottom: 5 }}>
            <span style={{ color: "var(--no)" }}>{labels.no} {cents(s.noPriceBp)}</span>
            <span style={{ color: "var(--yes)" }}>{cents(s.yesPriceBp)} {labels.yes}</span>
          </div>
          <div style={{ display: "flex", height: 10, borderRadius: 6, overflow: "hidden", background: "rgba(0,0,0,.4)" }}>
            <div style={{ width: `${s.noPriceBp / 100}%`, background: "linear-gradient(90deg,color-mix(in srgb,var(--no) 60%,#000),var(--no))" }} />
            <div style={{ flex: 1, background: "linear-gradient(90deg,var(--yes),color-mix(in srgb,var(--yes) 60%,#000))" }} />
          </div>
        </div>

        {/* actions — or the confirmation banner once accepted */}
        {acceptedInfo ? (
          <AcceptedBanner s={s} info={acceptedInfo} />
        ) : (
          <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
            <button
              type="button"
              onClick={busy ? undefined : () => onDismiss(s)}
              disabled={busy}
              style={{ padding: "9px 14px", borderRadius: 14, font: "inherit", cursor: busy ? "default" : "pointer", background: "rgba(0,0,0,.35)", border: "1.5px solid var(--line)", color: "var(--muted)", fontSize: 12, fontWeight: 700, opacity: busy ? 0.5 : 1 }}
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={busy ? undefined : () => onAccept(s)}
              disabled={busy}
              style={{
                flex: 1, minWidth: 0, padding: "9px 8px", borderRadius: 14, font: "inherit", cursor: busy ? "default" : "pointer",
                background: `color-mix(in srgb,${sideColor} 16%,transparent)`, border: `1.5px solid color-mix(in srgb,${sideColor} 50%,transparent)`,
                color: sideColor, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, opacity: busy ? 0.5 : 1,
              }}
            >
              {busy ? (
                <span style={{ fontFamily: "var(--df)", fontSize: 16, lineHeight: 1.5 }}>Placing…</span>
              ) : (
                <>
                  <span style={{ fontFamily: "var(--df)", fontSize: 16, lineHeight: 1, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ctaLabel}
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,.7)" }}>to win <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color: sideColor }}>{payout}</span></span>
                </>
              )}
            </button>
          </div>
        )}

        {/* honesty footnote — proxy is a proxy, discovery is never a hedge, sizing never claims math */}
        <div style={{ textAlign: "center", marginTop: 8, fontSize: 10, color: "rgba(255,255,255,.5)", letterSpacing: ".02em" }}>
          {footnote}
        </div>
      </div>
    </div>
  );
});

// The kind badge the spec insists on: an S1-proxy is labeled a proxy (basis risk), an S2 card is
// labeled a life-event bet AGAINST the supported side, and a discovery fallback is loudly flagged
// "not a hedge" (muted + dashed to read as a different species from the hedges above it).
function KindBadge({ s }: { s: HedgeSuggestion }) {
  // F13: discovery keys off the flag OR kind:"fallback" — never mislabel a fallback as "Direct hedge".
  const meta = s.isDiscovery === true || s.kind === "fallback"
    ? { color: "var(--muted)", label: "Discovery — not a hedge", dashed: true }
    : s.kind === "S2"
      ? { color: "var(--energy)", label: "Life hedge · against", dashed: false }
      : s.isProxy
        ? { color: "#ff8a3d", label: "Proxy · basis risk", dashed: false }
        : { color: "var(--yes)", label: "Direct hedge", dashed: false };
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "4px 9px", borderRadius: 18, background: `color-mix(in srgb,${meta.color} 18%,transparent)`, border: `1px ${meta.dashed ? "dashed" : "solid"} color-mix(in srgb,${meta.color} 55%,transparent)` }}>
      <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 800, color: meta.color }}>
        {meta.label}
      </span>
    </div>
  );
}

// Bet confirmation: shows the stake the SERVER actually locked (it may be clamped below the
// proposed size to available Cash — said out loud when it happens).
function AcceptedBanner({ s, info }: { s: HedgeSuggestion; info: AcceptedInfo }) {
  const color = s.side === "YES" ? "var(--yes)" : "var(--no)";
  // D9 optimistic: the tap already flipped the card here; the POST reconciles this in the background.
  if (info.placing) {
    return (
      <div style={{ padding: "12px", borderRadius: 16, background: `color-mix(in srgb,${color} 12%,transparent)`, border: `1.5px solid color-mix(in srgb,${color} 40%,transparent)` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <span style={{ fontSize: 13, color: "#fff" }}>
            Placing{" "}
            <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color }}>{usd(s.proposedStakeCents)}</span> on{" "}
            <span style={{ fontFamily: "var(--df)", color }}>{s.sideLabel}</span>…
          </span>
        </div>
      </div>
    );
  }
  const clamped = info.stakeCents < s.proposedStakeCents;
  return (
    <div style={{ padding: "12px", borderRadius: 16, background: `color-mix(in srgb,${color} 18%,transparent)`, border: `1.5px solid color-mix(in srgb,${color} 55%,transparent)` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span style={{ fontSize: 15, color }}>✓</span>
        <span style={{ fontSize: 13, color: "#fff" }}>
          {info.already ? "Already in your book — " : "You're in — "}
          <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color }}>{usd(info.stakeCents)}</span> on{" "}
          <span style={{ fontFamily: "var(--df)", color }}>{s.sideLabel}</span>
        </span>
      </div>
      {clamped && (
        <div style={{ textAlign: "center", fontSize: 10, color: "rgba(255,255,255,.65)", marginTop: 4 }}>
          Held to your free Cash — suggested {usd(s.proposedStakeCents)}.
        </div>
      )}
    </div>
  );
}

// The exposure summary returned by POST /api/hedge/wallet, rendered verbatim (server numbers).
function ExposurePanel({
  exposure,
  nowMs,
  busy,
  onRefresh,
  onToggleForm,
  formOpen,
}: {
  exposure: HedgeWalletResponse;
  nowMs: number;
  busy: boolean;
  onRefresh: () => void;
  onToggleForm: () => void;
  formOpen: boolean;
}) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "14px 16px", marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase" }}>Your wallet</div>
        <div style={{ fontFamily: "var(--nf)", fontSize: 11, color: "var(--text)" }}>{shortAddr(exposure.address)}</div>
        <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)" }}>updated {ago(exposure.snapshotFetchedAt, nowMs)}</div>
      </div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 30, color: "var(--text)", lineHeight: 1.1, marginTop: 8 }}>
        {usd(exposure.totalNotionalCents)}
      </div>
      <div style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase", marginTop: 2 }}>current exposure</div>

      {exposure.majors.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {exposure.majors.map((a) => (
            <div key={a.asset} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
              <span style={{ fontWeight: 700, color: "var(--text)", width: 44 }}>{a.asset}</span>
              <span style={{ fontFamily: "var(--nf)", color: "var(--muted)" }}>{fmtAmount(a.amount)}</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--nf)", fontWeight: 700, color: "var(--text)" }}>{usd(a.notionalCents)}</span>
            </div>
          ))}
          {exposure.splAggregateCents > 0 && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
              <span style={{ fontWeight: 700, color: "var(--muted)", width: 44 }}>SPL</span>
              <span style={{ color: "var(--muted)" }}>long tail</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--nf)", fontWeight: 700, color: "var(--text)" }}>{usd(exposure.splAggregateCents)}</span>
            </div>
          )}
        </div>
      )}
      {exposure.totalNotionalCents === 0 && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10 }}>
          Nothing priced in this wallet yet — hedges show up once there&apos;s exposure to cover.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <GhostButton onClick={onRefresh} disabled={busy}>{busy ? "Reading…" : "↻ Refresh"}</GhostButton>
        <GhostButton onClick={onToggleForm}>{formOpen ? "Cancel" : "Different wallet"}</GhostButton>
        <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 10, color: "var(--muted)" }}>Read-only — never your keys</span>
      </div>
    </div>
  );
}

// No-wallet intro: what this surface does + the paste field (the only way in).
function WalletIntro({
  address,
  busy,
  error,
  onAddress,
  onSubmit,
}: {
  address: string;
  busy: boolean;
  error: LinkError | null;
  onAddress: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "18px 16px", marginTop: 16 }}>
      <div style={{ fontFamily: "var(--df)", fontSize: 24, lineHeight: 1.05 }}>Hedge what you hold.</div>
      <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.55, marginTop: 8 }}>
        Paste a Solana address — read-only, we never ask for keys. We read the bag and offer paper hedges
        against it: 5–10% of a major (SOL / BTC / ETH) against a matching Polymarket market, ~3% of the
        long tail into a SOL short labeled a <b style={{ color: "var(--text)" }}>proxy</b> (basis risk — it
        tracks SOL, not your exact tokens). Hedges settle as ordinary paper bets; sizing is a product
        rule, not hedge math.
      </p>
      <div style={{ marginTop: 14 }}>
        <WalletForm address={address} busy={busy} error={error} onAddress={onAddress} onSubmit={onSubmit} />
      </div>
    </div>
  );
}

// The paste-an-address form shared by the intro and the "different wallet" panel. Validation is a
// light client-side pre-check only; the server does the real base58 check.
function WalletForm({
  address,
  busy,
  error,
  onAddress,
  onSubmit,
}: {
  address: string;
  busy: boolean;
  error: LinkError | null;
  onAddress: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div>
      <input
        value={address}
        onChange={(e) => onAddress(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !busy) onSubmit(); }}
        placeholder="Solana address (base58)"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Solana address"
        style={{ width: "100%", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 14px", color: "var(--text)", fontFamily: "var(--nf)", fontSize: 12, outline: "none" }}
      />
      {error && (
        <div style={{ fontSize: 11, color: "var(--no)", marginTop: 6, lineHeight: 1.4 }}>{LINK_ERROR_COPY[error]}</div>
      )}
      <button
        type="button"
        onClick={busy ? undefined : onSubmit}
        disabled={busy}
        style={{
          width: "100%", marginTop: 10, padding: "12px 14px", borderRadius: 14, fontFamily: "var(--nf)",
          fontWeight: 700, fontSize: 14, cursor: busy ? "default" : "pointer",
          border: "1px solid color-mix(in srgb,var(--energy) 50%,transparent)",
          background: "color-mix(in srgb,var(--energy) 16%,transparent)",
          color: "var(--energy)", opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Reading wallet…" : "Link wallet"}
      </button>
    </div>
  );
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13, padding: "0 24px" }}>{children}</div>
  );
}

function GhostButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{ padding: "7px 12px", borderRadius: 12, font: "inherit", fontSize: 11, fontWeight: 700, cursor: disabled ? "default" : "pointer", background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--muted)", opacity: disabled ? 0.6 : 1 }}
    >
      {children}
    </button>
  );
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

// UI token amount arrives as a decimal STRING (no float drift on the wire) — trim for display only.
function fmtAmount(a: string): string {
  const n = Number(a);
  if (!Number.isFinite(n)) return a;
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function ago(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
