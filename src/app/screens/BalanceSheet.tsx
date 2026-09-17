"use client";

import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from "react";
import type { StockPortfolioResponse, StockPositionRow } from "@/lib/api-types";
import { type Me, usd } from "../ui";
import { usePredictionHistory, useClosePosition, useExitQuotes, toPredictionRow } from "./usePredictionHistory";
import { PredictionRow } from "./PredictionRow";
import { StockHistoryRow } from "./PortfolioScreen";
import { ACTION, MUTED, RealDepositPanel } from "./RealDepositPanel";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The ONE money + history sheet. Opens from the balance chip in the HUD (every screen) and from the
// History row on the You screen. Top: the WALLET — one row per pocket, named by purpose (Paper, the
// play balance; Real · Stocks, the user's own Solana wallet; Real · Predictions, the Polymarket
// balance). Below: three tabs — Calls (prediction bets, /api/history), Stocks (tokenized-stock lots,
// /api/stocks/portfolio), Hedges (the accepted hedge legs of both kinds). Paper money is derived
// from `me` during render — no mirrored server state.
type Tab = "calls" | "stocks" | "hedges";
const TABS: { key: Tab; label: string }[] = [
  { key: "calls", label: "Calls" },
  { key: "stocks", label: "Stocks" },
  { key: "hedges", label: "Hedges" },
];

// Stock lots, fetched once the first time a tab that shows them opens (Stocks or Hedges). Open lots
// first, then closed — newest first within each, as the portfolio route already orders them.
function useStockHistory(api: Api, wanted: boolean) {
  const [rows, setRows] = useState<StockPositionRow[] | null>(null);
  useEffect(() => {
    if (!wanted || rows) return;
    let alive = true;
    void (async () => {
      try {
        const r = (await api("/api/stocks/portfolio")) as StockPortfolioResponse;
        if (alive) setRows([...r.open, ...r.closed]);
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => { alive = false; };
  }, [api, wanted, rows]);
  return rows;
}

export function BalanceSheet({ me, api, realPusdMicro, stockWallet, stockSponsored, onClose, onTopupDone, onToast }: {
  me: Me | null;
  api: Api;
  onClose: () => void;
  onTopupDone: () => void | Promise<void>;
  onToast: (msg: string) => void;
  realPusdMicro?: string | null;
  // The stock pocket, owned and polled by page.tsx so this sheet and the HUD state the same number.
  stockWallet: { address: string | null; embedded: boolean; usdCents: number | null; refresh: () => Promise<void>; unverified: boolean };
  stockSponsored: boolean;
}) {
  const [tab, setTab] = useState<Tab>("calls");
  const { rows, pending, nowMs, refresh, hasMore, loadMore, error } = usePredictionHistory(api);
  const { close, closing } = useClosePosition(api, me, onToast, refresh);
  // Which tabs actually show prediction rows. The Stocks tab shows none, so the 1s exit-quote poll
  // has nothing on screen to price — it must not run there.
  const callsVisible = tab === "calls" || tab === "hedges";
  const exitQuotes = useExitQuotes(api, rows, callsVisible); // live value + P&L for the closable rows, 1s
  const stocks = useStockHistory(api, tab !== "calls");
  const [busy, setBusy] = useState(false);

  const doTopup = useCallback(async (kind: "free" | "artifact") => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/topup", { method: "POST", body: JSON.stringify({ kind }) });
      await onTopupDone(); // parent refreshMe() → fresh cash/locked/topup
      onClose();
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 409 = free already used / no longer eligible (raced the gate); 402 = no artifact.
      onToast(status === 402 ? "Need an artifact to top up" : "Top-up unavailable right now");
    } finally {
      setBusy(false);
    }
  }, [api, busy, onClose, onTopupDone, onToast]);

  // What each tab lists. Hedges = the HEDGE-sourced rows of both kinds. ponytail: the calls side
  // filters the pages loaded so far (50 per page) — a hedge older than the loaded window shows up
  // after "Load more"; a server-side ?source= filter if that ever bites.
  const callRows = tab === "hedges" ? rows?.filter((r) => r.source === "HEDGE") ?? null : tab === "calls" ? rows : null;
  const stockRows = tab === "hedges" ? stocks?.filter((r) => r.source === "HEDGE") ?? null : tab === "stocks" ? stocks : null;
  const loading = (tab !== "stocks" && !rows) || (tab !== "calls" && !stocks);
  const empty = !loading && (callRows?.length ?? 0) + (stockRows?.length ?? 0) === 0;
  // The history read failed on a tab that shows its rows — "no calls yet" would be a lie.
  const failed = error && callsVisible;
  const emptyCopy =
    tab === "calls" ? "No predictions yet. Swipe a card to make your first call."
    : tab === "stocks" ? "No stocks yet. Swipe right on the Stocks deck to buy one."
    : "No hedges yet. The Hedge tab turns a life cost or a wallet into one.";
  const isReal = me?.real.mode === "REAL";

  return (
    // Backdrop is a real button: click/Enter/Escape closes (matches the overlay-click-to-close).
    // ponytail: reset to a plain div via button-reset inline styles so it looks identical.
    <div
      role="button"
      tabIndex={0}
      aria-label="Close"
      onClick={onClose}
      // Escape closes from anywhere in the sheet; Enter/Space only when the backdrop itself is the
      // focus target (not bubbled up from an inner control like the Top-Up button).
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
        else if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onClose(); }
      }}
      style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(4,4,8,.6)", backdropFilter: "blur(8px)", display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "hfRise .28s ease", border: "none", cursor: "default" }}
    >
      <div onClick={(e) => e.stopPropagation()} className="hf-scroll" style={{ background: "var(--bg2)", borderRadius: "28px 28px 0 0", borderTop: "1px solid var(--line)", padding: "8px 18px 22px", maxHeight: "82%", overflowY: "auto" }}>
        {/* The backdrop closes on click, but it only spans the DEVICE SURFACE — on desktop the app is
            a 402px phone mock and a click beside it lands on the page, not on this overlay. So the
            dismiss cannot live only there: this handle is a real button, and there is an X beside
            the title. Reported as "the sheet cannot be closed", which it could not, from outside. */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{ display: "block", margin: "0 auto 14px", padding: "6px 24px", background: "none", border: "none", cursor: "pointer" }}
        >
          <div style={{ width: 42, height: 5, borderRadius: 4, background: "var(--line)" }} />
        </button>

        <div style={{ fontFamily: "var(--df)", fontSize: 26, marginBottom: 12 }}>Wallet</div>

        {/* The pockets, ONE layout each (heading · number · what it is · actions), ordered by the
            app's Paper/Real switch: the pockets real mode spends first, play money last. In paper
            mode the Polymarket pocket is not shown — the switch itself lives on the Profile screen, so
            there is nothing to duplicate here. The Solana wallet is always shown: every login gets
            an embedded one, and a pocket you cannot see is a pocket you never fund. */}
        {isReal ? (
          <>
            <StockPocket wallet={stockWallet} sponsored={stockSponsored} onToast={onToast} />
            <RealDepositPanel me={me} api={api} pusdMicro={realPusdMicro ?? null} onToast={onToast} label="Real · Predictions" />
            <PaperPocket me={me} busy={busy} onTopup={doTopup} />
          </>
        ) : (
          <>
            <PaperPocket me={me} busy={busy} onTopup={doTopup} />
            <StockPocket wallet={stockWallet} sponsored={stockSponsored} onToast={onToast} />
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>History</div>
          {tab === "calls" && pending > 0 && <div style={{ fontSize: 11, color: "var(--skip)", fontWeight: 700 }}>{pending} open</div>}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ margin: "0 0 0 auto", font: "inherit", width: 30, height: 30, borderRadius: 999, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--muted)", fontSize: 15, lineHeight: 1, cursor: "pointer", flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        <div role="tablist" style={{ display: "flex", gap: 6, marginBottom: 12, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 999, padding: 3 }}>
          {TABS.map((t) => {
            const on = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t.key)}
                style={{ flex: 1, margin: 0, font: "inherit", padding: "7px 0", borderRadius: 999, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, letterSpacing: ".04em", background: on ? "var(--energy)" : "transparent", color: on ? "#fff" : "var(--muted)" }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>Loading…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* A failed history read hands back an empty list, which is indistinguishable from "you
                have never made a call" — and telling someone with open positions they have none is
                the worst thing this sheet can say. Say it failed; the retry IS the thing they tap.
                It sits above the rows rather than replacing them: on Hedges the stock legs loaded. */}
            {failed ? (
              <button
                type="button"
                onClick={() => void refresh()}
                style={{ width: "100%", margin: 0, font: "inherit", padding: 24, borderRadius: 14, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--muted)", fontSize: 13, cursor: "pointer" }}
              >
                Couldn&apos;t load — tap to retry
              </button>
            ) : null}
            {empty && !failed ? (
              <div style={{ textAlign: "center", color: "var(--muted)", padding: 24, fontSize: 13 }}>{emptyCopy}</div>
            ) : null}
            {stockRows?.map((r) => <StockHistoryRow key={r.id} row={r} />)}
            {callRows?.map((r) => (
              <PredictionRow key={r.id} row={toPredictionRow(r)} nowMs={nowMs} onClosePosition={() => close(r)} closing={closing === r.id} exitQuote={exitQuotes[r.id]} />
            ))}
            {tab !== "stocks" && hasMore && (
              <button
                type="button"
                onClick={() => void loadMore()}
                style={{ marginTop: 4, padding: "10px 14px", borderRadius: 12, font: "inherit", cursor: "pointer", background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--muted)", fontSize: 13, fontWeight: 700 }}
              >
                Load more
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// One pocket heading. Same 10px uppercase treatment for all three, so no pocket looks bigger than
// another — they are three different kinds of money, not a hierarchy.
const LABEL: CSSProperties = { fontSize: 10, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase", fontWeight: 700 };

// The one pocket layout — RealDepositPanel draws the Polymarket pocket in exactly this shape, so
// the three read as three kinds of money in one wallet, not three widgets.
function Pocket({ label, amount, color, note, children }: { label: string; amount: string; color: string; note: string; children?: ReactNode }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "16px 18px", marginBottom: 14 }}>
      <div style={LABEL}>{label}</div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 34, color, lineHeight: 1.05 }}>{amount}</div>
      <div style={{ ...MUTED, marginTop: 4, lineHeight: 1.5 }}>{note}</div>
      {children}
    </div>
  );
}

// PAPER — play money. The top-up lives here and nowhere else: the pockets are named, so "claim free
// $200" can no longer be mistaken for a way to fund a real one.
function PaperPocket({ me, busy, onTopup }: { me: Me | null; busy: boolean; onTopup: (k: "free" | "artifact") => void }) {
  return (
    <Pocket
      label="Paper"
      amount={me ? usd(Math.max(0, me.cashCents)) : "—"}
      color="var(--yes)"
      note={me ? `Play money. ${usd(me.lockedCents)} in play · ${usd(me.balanceCents)} total.` : "Play money."}
    >
      <TopupButton me={me} busy={busy} onTopup={onTopup} />
    </Pocket>
  );
}

// REAL · STOCKS. An embedded wallet has no wallet app of its own to show a balance or an address, so
// this sheet has to be that surface, or the user has nothing to fund and no way to know it arrived.
// No QR: no QR library is installed and one dependency for one square is a bad trade — the address
// is one tap away from the clipboard. This is one of the two places a token may be NAMED, because
// the sender has to know what to send.
function StockPocket({ wallet, sponsored, onToast }: {
  wallet: { address: string | null; embedded: boolean; usdCents: number | null; refresh: () => Promise<void>; unverified: boolean };
  sponsored: boolean;
  onToast: (m: string) => void;
}) {
  const { address, embedded, usdCents, refresh, unverified } = wallet;
  const copy = () => {
    if (!address) return;
    void navigator.clipboard
      .writeText(address)
      .then(() => onToast("Address copied"))
      .catch(() => onToast("Couldn't copy — select the address instead"));
  };
  const note = !address
    ? "Your Solana wallet is being set up…"
    : unverified
      // The server could not confirm ownership (usually a Privy hiccup). Say so instead of leaving
      // a permanent "—" that looks like an empty wallet.
      ? "Couldn't verify this wallet yet — refresh to try again."
      : !embedded
        ? "The wallet you connected — fund it from your wallet app."
        : sponsored
          ? "Your Solana wallet. Send USDC to this address — no SOL needed, network fees are on us."
          : "Your Solana wallet. Send USDC to this address, plus ~0.01 SOL for network fees.";

  return (
    <Pocket label="Real · Stocks" amount={usdCents == null ? "—" : usd(usdCents)} color="var(--gold)" note={note}>
      {address ? (
        <>
          <div style={{ marginTop: 10, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 11, color: "var(--text)", overflowWrap: "anywhere", lineHeight: 1.4 }}>{address}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={copy} style={{ ...ACTION, background: "var(--gold)", color: "#1a1205", border: "none" }}>
              Copy address
            </button>
            <button type="button" onClick={() => void refresh()} style={{ ...ACTION, background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--line)" }}>
              ↻ Refresh
            </button>
          </div>
        </>
      ) : null}
    </Pocket>
  );
}

// One affordance, derived from me.topup. Always visible; disabled when neither path is open.
function TopupButton({ me, busy, onTopup }: { me: Me | null; busy: boolean; onTopup: (k: "free" | "artifact") => void }) {
  if (!me) return null;
  const t = me.topup;
  const grant = usd(t.grantCents);

  // Holds an artifact but Cash is at/above the gate → the top-up is intentionally locked (it bails
  // out a low balance, not a full one). Show it inactive with the $ threshold, not "earn an artifact".
  const hasArtifact = me.artifacts >= t.artifactCost;
  const cashTooHigh = me.cashCents >= t.artifactCashGateCents;
  const gate = usd(t.artifactCashGateCents);

  let label: string, kind: "free" | "artifact" | null, primary = false;
  if (t.freeTopupAvailable) { label = `Claim free ${grant}`; kind = "free"; primary = true; }
  else if (t.artifactTopupAvailable) { label = `Top up ${grant} · 1 ◆`; kind = "artifact"; primary = true; }
  else if (hasArtifact && cashTooHigh) { label = `Top-up locked — Cash must be under ${gate}`; kind = null; }
  else if (!t.freeTopupUsed) { label = "Free top-up unlocks when low on cash"; kind = null; }
  else { label = "Earn an artifact to top up"; kind = null; }

  const disabled = kind === null || busy;
  return (
    <div style={{ display: "flex" }}>
      <button
        type="button"
        onClick={() => kind && onTopup(kind)}
        disabled={disabled}
        style={{
          ...ACTION,
          cursor: disabled ? "default" : "pointer",
          border: primary ? "none" : "1px solid var(--line)",
          background: primary ? "var(--yes)" : "var(--panel2)",
          color: primary ? "#06140b" : "var(--muted)",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "…" : label}
      </button>
    </div>
  );
}
