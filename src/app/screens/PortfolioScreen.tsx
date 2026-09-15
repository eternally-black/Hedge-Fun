"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { type Me, usd } from "../ui";
import { REAL_BALANCE_POLL_MS } from "@/lib/config";
import type { StockPortfolioResponse, StockPositionRow, StockWalletResponse } from "@/lib/api-types";
import { isWalletUnverified, useBuyReal } from "../useBuyReal";
import { StockConsentSheet } from "./StockConsentSheet";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The Portfolio (Stocklana): every tokenized-stock lot the user owns, paper and on-chain, in one
// list. Open lots carry their live mark and a two-tap Sell (paper) or a Buy-on-Solana ghost button
// (real, via the user's own wallet). Closed lots collapse behind a toggle — they are history, not
// the thing you came to look at. Pending real buys show as a strip while the poller confirms them.
export function PortfolioScreen({
  api,
  me,
  onRefreshMe,
  onToast,
}: {
  api: Api;
  me: Me | null;
  onRefreshMe: () => void | Promise<void>;
  onToast: (m: string) => void;
}) {
  const [data, setData] = useState<StockPortfolioResponse | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [selling, setSelling] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(armTimer.current), []);

  const load = useCallback(async () => {
    try {
      const r = (await api("/api/stocks/portfolio")) as StockPortfolioResponse;
      setData(r);
    } catch (e) {
      console.error(e);
    }
  }, [api]);

  const real = useBuyReal({
    api,
    me,
    onToast,
    onRefreshMe,
    ctx: { wallets: data?.wallets ?? [], stockConsent: data?.stockConsent ?? false, sponsored: data?.sponsored },
    onDone: () => { void load(); void onRefreshMe(); },
  });
  const replayPending = real.replayPending;
  const sellReal = real.sellReal;

  // Selling a REAL lot is the same two-tap as a paper sell, but the work happens in the hook (build,
  // sign, submit, confirm). `selling` is shared: a row is either paper or on-chain, never both.
  const sellOnChain = useCallback(
    async (row: StockPositionRow) => {
      setSelling(row.id);
      try {
        await sellReal(row.id, { symbol: row.symbol, ctx: { wallets: data?.wallets ?? [], stockConsent: data?.stockConsent ?? false, sponsored: data?.sponsored } });
      } finally {
        setSelling(null);
      }
    },
    [data?.sponsored, data?.stockConsent, data?.wallets, sellReal],
  );

  // Initial load + one replay of any pending real buy (a tab that died before /confirm). If the
  // replay confirmed anything, refetch so the new lot appears and say so.
  useEffect(() => {
    let alive = true;
    void (async () => {
      await load();
      try {
        const n = await replayPending();
        if (!alive) return;
        if (n > 0) {
          await load();
          onToast("Confirmed a pending Solana buy");
        }
      } catch (e) {
        console.error(e);
      }
    })();
    return () => { alive = false; };
  }, [load, onToast, replayPending]);

  // Visibility-gated re-poll: a hidden tab is a read for a number nobody is looking at. Coming back
  // re-reads immediately, which is also the moment someone returns from the wallet they just bought
  // from. Same pattern as the HUD's real-balance poll.
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      timer = window.setInterval(() => void load(), REAL_BALANCE_POLL_MS);
    };
    const onVis = () => {
      if (document.hidden) return stop();
      void load();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [load]);

  const sell = useCallback(
    async (row: StockPositionRow) => {
      setSelling(row.id);
      try {
        const r = (await api("/api/stocks/sell", {
          method: "POST",
          body: JSON.stringify({ positionId: row.id }),
        })) as { proceedsCents: number; pnlCents: number };
        const pnl = r.pnlCents;
        onToast(`Sold ${row.symbol}: ${pnl >= 0 ? "+" : ""}${usd(pnl)}`);
        await load();
        await onRefreshMe();
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409) onToast("Already sold");
        else if (status === 502) onToast("Price unavailable — try again");
        else console.error(e);
      } finally {
        setSelling(null);
      }
    },
    [api, load, onRefreshMe, onToast],
  );

  const open = data?.open ?? [];
  const closed = data?.closed ?? [];
  const pending = data?.pendingAttempts ?? [];
  const paper = data?.totals.paper ?? { costCents: 0, valueCents: 0, pnlCents: 0 };
  const realTotals = data?.totals.real ?? { costCents: 0, valueCents: 0, pnlCents: 0 };
  const hasReal = realTotals.costCents > 0 || open.some((r) => r.mode === "REAL");

  return (
    <>
      <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 20px" }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 26, marginTop: 4 }}>Portfolio</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Tokenized stocks you own — paper and on-chain.</div>

        {real.embedded && real.walletAddress ? (
          <FundPanel
            api={api}
            address={real.walletAddress}
            sponsored={data?.sponsored ?? false}
            verified={(data?.wallets ?? []).includes(real.walletAddress)}
            ensureVerified={real.ensureVerified}
            onToast={onToast}
          />
        ) : null}

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <TotalTile label="Paper" totals={paper} />
          {hasReal ? <TotalTile label="On-chain" totals={realTotals} /> : null}
        </div>

        {pending.length > 0 ? (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            {pending.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: "9px 12px", fontSize: 12, color: "var(--muted)" }}>
                <span aria-hidden="true" style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid var(--line)", borderTopColor: "var(--energy)", animation: "hfSpin .8s linear infinite" }} />
                <span>Confirming {p.symbol} · {usd(p.stakeCents)}…</span>
              </div>
            ))}
          </div>
        ) : null}

        {data === null ? (
          <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13 }}>Loading…</div>
        ) : open.length === 0 && closed.length === 0 ? (
          <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13 }}>
            No stocks yet. Swipe right on the Stocks deck to buy your first one.
          </div>
        ) : (
          <>
            {open.length > 0 ? (
              <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {open.map((row) => (
                  <OpenRow
                    key={row.id}
                    row={row}
                    armed={armed === row.id}
                    selling={selling === row.id}
                    onArm={() => {
                      setArmed(row.id);
                      window.clearTimeout(armTimer.current);
                      armTimer.current = window.setTimeout(() => setArmed(null), 3000);
                    }}
                    onSell={() => {
                      window.clearTimeout(armTimer.current);
                      setArmed(null);
                      void (row.mode === "REAL" ? sellOnChain(row) : sell(row));
                    }}
                    onBuyReal={() =>
                      void real.buyReal(
                        { assetId: row.assetId, symbol: row.symbol },
                        1000,
                        { wallets: data?.wallets ?? [], stockConsent: data?.stockConsent ?? false },
                      )
                    }
                  />
                ))}
              </div>
            ) : null}

            {closed.length > 0 ? (
              <div style={{ marginTop: 20 }}>
                <button
                  type="button"
                  onClick={() => setClosedOpen((o) => !o)}
                  style={{ margin: 0, font: "inherit", background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", fontWeight: 700 }}
                >
                  Closed · {closed.length}
                  <span aria-hidden="true" style={{ fontSize: 10, transform: closedOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</span>
                </button>
                {closedOpen ? (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                    {closed.map((row) => (
                      <ClosedRow key={row.id} row={row} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      <StockConsentSheet
        open={real.consentOpen}
        busy={real.busy}
        sponsored={data?.sponsored ?? false}
        onAccept={real.acceptConsent}
        onClose={real.closeConsent}
      />
    </>
  );
}

// FundPanel — "send USDC here". An embedded wallet has no wallet app of its own to show a balance
// or an address, so the app has to be that surface, or the user has nothing to fund and no way to
// know it arrived. No QR: no QR library is installed and one dependency for one square is a bad
// trade — the address is one tap away from the clipboard.
function FundPanel({ api, address, sponsored, verified, ensureVerified, onToast }: {
  api: Api;
  address: string;
  sponsored: boolean;
  verified: boolean;
  ensureVerified: (address: string) => Promise<void>;
  onToast: (m: string) => void;
}) {
  const [usdcCents, setUsdcCents] = useState<number | null>(null);
  // Said once, not every 15s: this load is on a poll, and a Privy outage would otherwise repeat the
  // same toast until it clears.
  const warnedUnverified = useRef(false);

  const load = useCallback(async () => {
    try {
      // /stocks/wallet answers only for a VERIFIED address, and a freshly created embedded wallet is
      // not one until we tell the server about it — this panel is usually the first place that needs it.
      if (!verified) await ensureVerified(address);
      const r = (await api(`/api/stocks/wallet?address=${address}`)) as StockWalletResponse;
      setUsdcCents(r.usdcCents);
    } catch (e) {
      if (isWalletUnverified(e)) {
        if (!warnedUnverified.current) {
          warnedUnverified.current = true;
          onToast("Couldn't verify your wallet — try again in a moment");
        }
        return;
      }
      console.error(e);
    }
  }, [address, api, ensureVerified, onToast, verified]);

  // Same visibility-gated poll as the portfolio list. What is being watched here is USDC arriving
  // from somewhere else entirely, so returning to the tab must re-read immediately.
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      timer = window.setInterval(() => void load(), REAL_BALANCE_POLL_MS);
    };
    const onVis = () => {
      if (document.hidden) return stop();
      void load();
      start();
    };
    // "We are visible now" is exactly the mount case too — read once, then start the clock. Going
    // through onVis rather than calling load() here keeps the first setState off the effect body.
    onVis();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [load]);

  const copy = () => {
    void navigator.clipboard
      .writeText(address)
      .then(() => onToast("Address copied"))
      .catch(() => onToast("Couldn't copy — select the address instead"));
  };

  return (
    <div style={{ marginTop: 14, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 13px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>Your Solana wallet</div>
        <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15 }}>{usdcCents == null ? "—" : usd(usdcCents)}</div>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh balance"
          style={{ margin: 0, font: "inherit", padding: "3px 8px", borderRadius: 8, background: "transparent", color: "var(--muted)", border: "1px solid var(--line)", fontWeight: 700, fontSize: 11, cursor: "pointer" }}
        >
          ↻
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
        <div style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 11, color: "var(--text)", overflowWrap: "anywhere", lineHeight: 1.4 }}>{address}</div>
        <button
          type="button"
          onClick={copy}
          style={{ margin: 0, font: "inherit", flexShrink: 0, padding: "6px 11px", borderRadius: 10, background: "transparent", color: "var(--muted)", border: "1px solid var(--line)", fontWeight: 700, fontSize: 11, cursor: "pointer" }}
        >
          Copy
        </button>
      </div>

      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 9, lineHeight: 1.5 }}>
        {sponsored
          ? "Send USDC (Solana) here. No SOL needed — network fees are on us."
          : "Send USDC (Solana) here, plus ~0.01 SOL for network fees."}
      </div>
    </div>
  );
}

// One total tile: the big number is what the lots are worth now, the line under it is the P&L
// against what they cost.
function TotalTile({ label, totals }: { label: string; totals: { costCents: number; valueCents: number; pnlCents: number } }) {
  const pnl = totals.pnlCents;
  return (
    <div style={{ flex: 1, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 13px" }}>
      <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 22, marginTop: 4 }}>{usd(totals.valueCents)}</div>
      <div style={{ fontSize: 11, marginTop: 3, color: pnl >= 0 ? "var(--yes)" : "var(--no)" }}>
        {signed(pnl)}
        <span style={{ color: "var(--muted)" }}> (cost {usd(totals.costCents)})</span>
      </div>
    </div>
  );
}

// "+$1.05" / "−$0.40" (U+2212) — usd() formats the magnitude, the sign is ours.
function signed(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

// Display quantity: raw base units → whole shares, scaled by the Token-2022 UI multiplier when the
// mint carries one (so it matches what Phantom shows). Four decimals is honest precision.
function fmtQty(row: StockPositionRow): string {
  const raw = Number(row.qtyBase) / 10 ** row.decimals;
  const scaled = raw * (row.uiMultiplierMicro ? row.uiMultiplierMicro / 1e6 : 1);
  return `${scaled.toFixed(4)} sh`;
}

function OpenRow({
  row,
  armed,
  selling,
  onArm,
  onSell,
  onBuyReal,
}: {
  row: StockPositionRow;
  armed: boolean;
  selling: boolean;
  onArm: () => void;
  onSell: () => void;
  onBuyReal: () => void;
}) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--yes)" : "var(--no)";
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 13px" }}>
      <div style={{ display: "flex", gap: 11 }}>
        <Logo url={row.logoUrl} symbol={row.symbol} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{row.symbol}</span>
            <span style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
            {row.mode === "REAL" ? (
              row.txSig ? (
                <a href={`https://solscan.io/tx/${row.txSig}`} target="_blank" rel="noreferrer" style={{ fontSize: 10, fontWeight: 700, color: "var(--gold)", background: "color-mix(in srgb,var(--gold) 14%,var(--panel))", border: "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))", padding: "2px 7px", borderRadius: 20, textDecoration: "none" }}>◎ on-chain</a>
              ) : (
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--gold)", background: "color-mix(in srgb,var(--gold) 14%,var(--panel))", border: "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))", padding: "2px 7px", borderRadius: 20 }}>◎ on-chain</span>
              )
            ) : (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--panel2)", border: "1px solid var(--line)", padding: "2px 7px", borderRadius: 20 }}>PAPER</span>
            )}
            {row.source === "HEDGE" ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--panel2)", border: "1px solid var(--line)", padding: "2px 7px", borderRadius: 20 }}>hedge</span>
            ) : null}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
            {fmtQty(row)} · entry {usd(row.entryPriceCents)} → now {row.priceCents == null ? "—" : usd(row.priceCents)}
          </div>
          <div style={{ fontSize: 11, marginTop: 2, color: pnlColor }}>
            {pnl == null ? "—" : signed(pnl)}
            {!row.fresh ? <span style={{ color: "var(--muted)" }}> · cached</span> : null}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={onBuyReal}
          style={{ margin: 0, font: "inherit", padding: "7px 12px", borderRadius: 10, background: "transparent", color: "var(--muted)", border: "1px solid var(--line)", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
        >
          ◎ Buy on Solana
        </button>
        {/* Same two-tap for both modes — a REAL sell is a swap back to USDC, which is no more
            undoable than a paper one, so it gets the same "are you sure" gesture and the same look. */}
        <button
          type="button"
          disabled={selling}
          onClick={armed ? onSell : onArm}
          style={{
            margin: 0, font: "inherit",
            padding: "7px 12px", borderRadius: 10,
            background: armed ? "var(--gold)" : "transparent",
            color: armed ? "#1a1205" : "var(--muted)",
            border: "1px solid " + (armed ? "var(--gold)" : "var(--line)"),
            fontWeight: 700, fontSize: 11,
            cursor: selling ? "default" : "pointer",
            opacity: selling ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {selling ? "Selling…" : armed ? "Sell?" : row.mode === "REAL" ? "◎ Sell on Solana" : "Sell"}
        </button>
      </div>
    </div>
  );
}

function ClosedRow({ row }: { row: StockPositionRow }) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--yes)" : "var(--no)";
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "10px 13px", display: "flex", alignItems: "center", gap: 11 }}>
      <Logo url={row.logoUrl} symbol={row.symbol} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{row.symbol}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          {row.closeReason === "wallet" ? "moved in wallet" : "sold"}
          {/* The sale has its own signature — the buy link on the open row is gone once it closes. */}
          {row.sellTxSig ? (
            <>
              {" · "}
              <a href={`https://solscan.io/tx/${row.sellTxSig}`} target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>
                ◎ sale
              </a>
            </>
          ) : null}
        </div>
      </div>
      {pnl != null ? (
        <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, color: pnlColor, whiteSpace: "nowrap" }}>
          {signed(pnl)}
        </div>
      ) : null}
    </div>
  );
}

// Read-only row for the unified history sheet (BalanceSheet): open or closed, paper or on-chain,
// deck or hedge. No actions here — selling and buying stay on the Portfolio screen.
const PILL: CSSProperties = { fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--panel2)", border: "1px solid var(--line)", padding: "2px 7px", borderRadius: 20 };
export function StockHistoryRow({ row }: { row: StockPositionRow }) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--yes)" : "var(--no)";
  const closed = row.closedAt != null;
  const sub = closed
    ? `${row.closeReason === "wallet" ? "moved in wallet" : "sold"}${row.proceedsCents != null ? ` · ${usd(row.proceedsCents)}` : ""}`
    : `${fmtQty(row)} · ${usd(row.entryPriceCents)}${row.priceCents != null ? ` → ${usd(row.priceCents)}` : ""}`;
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "10px 13px", display: "flex", alignItems: "center", gap: 11, opacity: closed ? 0.8 : 1 }}>
      <Logo url={row.logoUrl} symbol={row.symbol} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13 }}>
          <span>{row.symbol}</span>
          <span style={row.mode === "REAL" ? { ...PILL, color: "var(--gold)" } : PILL}>{row.mode === "REAL" ? "◎ on-chain" : "PAPER"}</span>
          {row.source === "HEDGE" && <span style={PILL}>🛡 hedge</span>}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
      </div>
      {pnl != null && <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, color: pnlColor, whiteSpace: "nowrap" }}>{signed(pnl)}</div>}
    </div>
  );
}

// 36px round logo with an initials fallback — the same shape every row in the app uses.
function Logo({ url, symbol }: { url: string | null; symbol: string }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={36} height={36} style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--panel2)" }} />;
  }
  return (
    <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--panel2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--df)", fontSize: 12, color: "var(--muted)", flexShrink: 0 }}>
      {symbol.slice(0, 3)}
    </div>
  );
}
