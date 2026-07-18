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
  HedgeSuggestion,
  HedgeSuggestionsResponse,
  HedgeWalletResponse,
} from "@/lib/api-types";

// Whatever useApi resolves to — a thrown error carries `.status` (mirrors page.tsx's catch blocks).
type Api = (path: string, init?: RequestInit) => Promise<unknown>;

type AcceptedInfo = { stakeCents: number; already: boolean };
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
  me,
  onRefreshMe,
  onToast,
  onTopup,
}: {
  api: Api;
  me: Me | null;
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

  // Latest-value ref so the accept callback stays identity-stable across /api/me refreshes.
  const meRef = useRef<Me | null>(me);
  useEffect(() => { meRef.current = me; }, [me]);
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

  // First load on mount.
  useEffect(() => { void loadSuggestions(); }, [loadSuggestions]);

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
  const accept = useCallback(
    (s: HedgeSuggestion) => {
      if (inFlight.current.has(s.suggestionId)) return;
      const m = meRef.current;
      if (m && m.cashCents <= 0) { onToast("No free cash — top up to keep going"); onTopup(); return; }
      beginPending(s.suggestionId);
      api("/api/hedge/accept", { method: "POST", body: JSON.stringify({ suggestionId: s.suggestionId }) })
        .then((r) => {
          const res = r as HedgeAcceptResponse;
          setAccepted((prev) => new Map(prev).set(s.suggestionId, { stakeCents: res.stakeCents, already: res.alreadyAccepted }));
          onRefreshMe(); // the stake locks against Cash — repaint the HUD balance
        })
        .catch((e) => {
          const status = (e as { status?: number }).status;
          if (status === 402) { onToast("No free cash — top up to keep going"); onTopup(); }
          else if (status === 404 || status === 409) { onToast("That suggestion went stale — refreshing"); void loadSuggestions(); }
          else { onToast("Couldn't place the hedge — try again"); console.error(e); }
        })
        .finally(() => endPending(s.suggestionId));
    },
    [api, beginPending, endPending, loadSuggestions, onRefreshMe, onToast, onTopup],
  );

  // Dismiss → telemetry event + optimistic removal. 404 = the suggestion stopped deriving (stale);
  // the card is already gone locally, so there's nothing to roll back. The id also goes into the
  // session dismissed-set so the next reload doesn't resurrect it (see loadSuggestions).
  const dismiss = useCallback(
    (s: HedgeSuggestion) => {
      if (inFlight.current.has(s.suggestionId)) return;
      beginPending(s.suggestionId);
      dismissed.current.add(s.suggestionId);
      setSuggestions((prev) => prev?.filter((x) => x.suggestionId !== s.suggestionId) ?? prev);
      api("/api/hedge/event", { method: "POST", body: JSON.stringify({ suggestionId: s.suggestionId, event: "dismiss" }) })
        .catch((e) => {
          const status = (e as { status?: number }).status;
          if (status !== 404) console.error(e);
        })
        .finally(() => endPending(s.suggestionId));
    },
    [api, beginPending, endPending],
  );

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
    </div>
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
  // Exactly one impression per card mount; the screen-level Set dedupes remounts/StrictMode.
  useEffect(() => { onImpression(s.suggestionId); }, [onImpression, s.suggestionId]);

  const cat = catOf(s);
  const labels = sideLabels(s);
  const cd = countdown(s.resolutionDeadline, nowMs);
  const sideColor = s.side === "YES" ? "var(--yes)" : "var(--no)";
  const sidePriceBp = s.side === "YES" ? s.yesPriceBp : s.noPriceBp;
  const payout = winPayout(sidePriceBp, s.proposedStakeCents);

  return (
    <div style={{ position: "relative", borderRadius: 22, overflow: "hidden", background: "var(--panel2)", border: "1px solid var(--line)", boxShadow: "0 18px 40px -20px rgba(0,0,0,.7)" }}>
      <div style={{ position: "absolute", inset: 0, background: bgGrad(cat.color) }} />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", padding: "14px 15px" }}>
        {/* kind badge + category + countdown */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <KindBadge proxy={s.isProxy} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: cat.color, boxShadow: `0 0 8px ${cat.color}` }} />
            <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>{cat.label}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18, border: `1px solid ${cd.urgent ? "color-mix(in srgb,var(--no) 60%,transparent)" : "transparent"}` }}>
            <span style={{ fontSize: 11 }}>⏱</span>
            <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 12, color: cd.urgent ? "var(--no)" : "#fff" }}>{cd.text}</span>
          </div>
        </div>

        {/* question + hedge context */}
        <div style={{ padding: "10px 0" }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 20, lineHeight: 1.08, letterSpacing: ".2px", color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,.5)" }}>{displayQuestion(s)}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,.75)" }}>
            Hedges your <span style={{ fontWeight: 700, color: "#fff" }}>{s.hedgedAsset}</span> · {usd(s.hedgedNotionalCents)} exposure
          </div>
          {/* D4 degradation: the avg-buy-cost line renders ONLY when the server sends one. */}
          {s.avgBuyCostNarrative && (
            <div style={{ marginTop: 3, fontSize: 11, color: "rgba(255,255,255,.6)" }}>{s.avgBuyCostNarrative}</div>
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
                    Hedge {usd(s.proposedStakeCents)} on {s.sideLabel}
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,.7)" }}>to win <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color: sideColor }}>${payout}</span></span>
                </>
              )}
            </button>
          </div>
        )}

        {/* honesty footnote — proxy is labeled a proxy, sizing never claims hedge-math equivalence */}
        <div style={{ textAlign: "center", marginTop: 8, fontSize: 10, color: "rgba(255,255,255,.5)", letterSpacing: ".02em" }}>
          {s.isProxy
            ? "Proxy — shorts SOL, not your exact tokens. Basis risk · sizing is a product rule, not hedge math."
            : "Paper bet · sizing is a product rule, not hedge math."}
        </div>
      </div>
    </div>
  );
});

// The kind badge the spec insists on: an S1-proxy is labeled a proxy (basis risk), never a hedge.
function KindBadge({ proxy }: { proxy: boolean }) {
  const color = proxy ? "#ff8a3d" : "var(--yes)";
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "4px 9px", borderRadius: 18, background: `color-mix(in srgb,${color} 18%,transparent)`, border: `1px solid color-mix(in srgb,${color} 55%,transparent)` }}>
      <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 800, color }}>
        {proxy ? "Proxy · basis risk" : "Direct hedge"}
      </span>
    </div>
  );
}

// Bet confirmation: shows the stake the SERVER actually locked (it may be clamped below the
// proposed size to available Cash — said out loud when it happens).
function AcceptedBanner({ s, info }: { s: HedgeSuggestion; info: AcceptedInfo }) {
  const color = s.side === "YES" ? "var(--yes)" : "var(--no)";
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
