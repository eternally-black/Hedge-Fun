"use client";

import { memo, useEffect, useRef, useState } from "react";
import { usd } from "./ui";
import { clampStakeCents } from "./useStockStake";
import { STOCK_MIN_STAKE_CENTS, STOCK_STAKE_PRESETS_CENTS } from "@/lib/config";
import { SwipeShell, PREVIEW_SCALE, PREVIEW_Y, useTick, type SwipeAction } from "./DeckCard";
import type { StockDeckCard } from "@/lib/api-types";

// The stock deck's accent. Deliberately NOT one of the category colors: a stock card is a different
// species from a prediction card (it never resolves, it has no two sides), and it must not read as
// one of the market categories it sits beside.
export const STOCK_ACCENT = "#34d399";

// A stable no-op for the preview card: an inline `() => {}` is a new value every render, which is
// exactly what memo() compares — the preview would re-render with the deck behind it for nothing.
const NOOP = () => {};

// ============================================================================
// StockCardFace — the full card VISUALS, pure + memoized. Same layering discipline as CardFace:
// background → directional overlays → stamps → content. No gesture, no clock of its own beyond the
// price pulse (which is a value-driven animation, not a tick).
// ============================================================================
type FaceProps = {
  card: StockDeckCard;
  yesP: number;
  noP: number;
  skipP: number;
  stakeCents: number;
  onPickStake: (c: number) => void;
  onBuyReal?: () => void;
  // A real buy is in flight (signature + chain confirmation): the CTA must not fire a second one.
  buyRealBusy?: boolean;
  walletLinked: boolean;
  consented: boolean;
  // What the REAL · STOCKS pocket holds, in cents (null = not known yet). The CTA states the amount
  // it will actually spend, so a $50 chip over a $12 wallet says $12 before the signature, not after.
  stocksUsdCents: number | null;
  // Tapped instead of buying when the wallet cannot cover the minimum — the fix is funding, and the
  // wallet sheet is where the address lives.
  onOpenWallet?: () => void;
};

export const StockCardFace = memo(function StockCardFace({ card, yesP, noP, skipP, stakeCents, onPickStake, onBuyReal, buyRealBusy, walletLinked, consented, stocksUsdCents, onOpenWallet }: FaceProps) {
  // The price pulses exactly like the odds do on a prediction card: a number that changes between
  // frames reads as a number that never moves. Same hook, same animation names.
  const priceTick = useTick(card.priceCents);
  const stamp = (p: number) => ({ o: Math.max(0, Math.min(1, (p - 0.15) / 0.5)), s: 0.6 + 0.4 * Math.min(1, p) });
  const ys = stamp(yesP), ns = stamp(noP), ks = stamp(skipP);
  const change = card.change24hBp;
  const changeText = change == null ? "—" : `${change >= 0 ? "+" : "−"}${(Math.abs(change) / 100).toFixed(2)}%`;
  const changeColor = change == null ? "var(--muted)" : change >= 0 ? "var(--yes)" : "var(--no)";
  // ONE decision drives the label AND the tap. They used to be computed apart, so a user with no
  // consent and an empty wallet read "Accept xStocks terms to buy" and got the wallet sheet — the
  // consent step was unreachable. `connect` / `consent` / `buy` all go to the hook, which owns the
  // link and consent prompts; only `fund` is ours, because funding is not something the hook can do.
  // Too little to trade: the tap has to lead somewhere, and "Buy" that always fails is the worst of
  // the options. Unknown balance (null) keeps the plain label — an amount we cannot state honestly.
  const underfunded = stocksUsdCents !== null && stocksUsdCents < STOCK_MIN_STAKE_CENTS;
  const intent: "busy" | "connect" | "consent" | "fund" | "buy" = buyRealBusy
    ? "busy"
    : !walletLinked
      ? "connect"
      : !consented
        ? "consent"
        : underfunded
          ? "fund"
          : "buy";
  const buyLabel =
    intent === "busy"
      ? "Buying…"
      : intent === "connect"
        ? "Connect Phantom to buy on Solana"
        : intent === "consent"
          ? "Accept xStocks terms to buy"
          : intent === "fund"
            ? "◎ Fund your wallet to buy on Solana"
            : stocksUsdCents === null
              ? "◎ Buy on Solana"
              : `◎ Buy ${usd(Math.min(stakeCents, stocksUsdCents))} on Solana`;

  return (
    <>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, color-mix(in srgb, ${STOCK_ACCENT} 18%, var(--panel2)), var(--panel2) 70%)` }} />

      {/* directional overlays — same geometry as CardFace, so the gesture reads identically */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: yesP, background: "linear-gradient(270deg, color-mix(in srgb,var(--yes) 70%, transparent), transparent 65%)" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: noP, background: "linear-gradient(90deg, color-mix(in srgb,var(--no) 70%, transparent), transparent 65%)" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: skipP, background: "radial-gradient(120% 70% at 50% 34%, color-mix(in srgb,var(--skip) 60%, transparent), transparent 62%)" }} />

      {/* stamps — BUY right, PASS left, SKIP top (mirrors the deck's YES/NO/SKIP placement) */}
      <StockStamp label="PASS" color="var(--no)" o={ns.o} s={ns.s} pos={{ top: 42, left: 26 }} rot={-15} />
      <StockStamp label="BUY" color="var(--yes)" o={ys.o} s={ys.s} pos={{ top: 42, right: 26 }} rot={15} />
      <StockStamp label="SKIP" color="var(--skip)" o={ks.o} s={ks.s} pos={{ top: 30, left: "50%", marginLeft: -62 }} rot={0} />

      {/* content */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: "16px 18px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "6px 11px", borderRadius: 20 }}>
            <StockLogo card={card} />
            <span style={{ fontSize: 11, letterSpacing: ".08em", fontWeight: 800, color: "#fff" }}>{card.symbol}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "6px 11px", borderRadius: 20 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: card.openNow ? "var(--yes)" : "var(--muted)" }} />
            <span style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>
              {card.tradingHours === "TwentyFourFive" ? "24/5" : "Mkt hours"}
            </span>
          </div>
          {!card.tradable && (
            <div style={{ display: "flex", alignItems: "center", background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "6px 11px", borderRadius: 20 }}>
              <span style={{ fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 700, color: "var(--muted)" }}>Paper only</span>
            </div>
          )}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "14px 0" }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 30, lineHeight: 1.06, letterSpacing: ".2px", color: "#fff", textShadow: "0 2px 20px rgba(0,0,0,.5)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{card.name}</div>
          {/* the one-line "what this is" — only when the server has one; no placeholder line. */}
          {card.blurb && (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted)", lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{card.blurb}</div>
          )}
          <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,.6)", letterSpacing: ".02em" }}>{card.underlying}</div>
          <div style={{ marginTop: 14, display: "flex", alignItems: "baseline", gap: 10 }}>
            {/* keyed on the price: a new key remounts the number, which is what restarts the pulse */}
            <div key={card.priceCents} style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 40, lineHeight: 1, color: "#fff", animation: priceTick }}>{usd(card.priceCents)}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: changeColor }}>{changeText}</span>
              <span style={{ fontSize: 10, color: "var(--muted)", letterSpacing: ".08em", textTransform: "uppercase" }}>24h</span>
            </div>
          </div>
        </div>

        <StakeChips stakeCents={stakeCents} onPickStake={onPickStake} />

        {card.tradable && !onBuyReal && (
          // Preview card: no CTA to offer, but its HEIGHT has to be here or the card jumps the
          // moment this preview is promoted to the top slot.
          <div aria-hidden="true" style={{ width: "100%", padding: "11px 14px", borderRadius: 14, border: "1px solid var(--line)", background: "rgba(0,0,0,.2)", fontSize: 13, fontWeight: 700 }}>&nbsp;</div>
        )}

        {card.tradable && onBuyReal && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (intent === "fund") onOpenWallet?.(); else onBuyReal(); }}
            disabled={buyRealBusy}
            style={{
              margin: 0,
              font: "inherit",
              width: "100%",
              padding: "11px 14px",
              borderRadius: 14,
              background: "color-mix(in srgb, " + STOCK_ACCENT + " 16%, transparent)",
              border: "1px solid color-mix(in srgb, " + STOCK_ACCENT + " 50%, transparent)",
              color: STOCK_ACCENT,
              fontWeight: 700,
              fontSize: 13,
              cursor: buyRealBusy ? "default" : "pointer",
              opacity: buyRealBusy ? 0.5 : 1,
            }}
          >
            {buyLabel}
          </button>
        )}

        <div style={{ textAlign: "center", marginTop: 12, fontSize: 11, color: "rgba(255,255,255,.55)", letterSpacing: ".02em" }}>Swipe right to buy · left to pass</div>
      </div>
    </>
  );
});

// The amount row: three preset sizes plus one the user types. Its own component because the custom
// chip carries state (open, draft, refused) and StockCardFace is memo()'d — a keystroke must not
// re-render the card behind it. Inert on the preview card, which turns pointer events off wholesale.
function StakeChips({ stakeCents, onPickStake }: { stakeCents: number; onPickStake: (c: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // A refused amount flashes. Without it a fat-fingered "600" just closes the input and leaves the
  // old stake standing, which reads as a tap the card ignored.
  const [refused, setRefused] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // Any stake that is not a preset belongs to the custom chip — that is what puts a remembered $37
  // back on the card instead of leaving all four chips looking unselected.
  const custom = !(STOCK_STAKE_PRESETS_CENTS as readonly number[]).includes(stakeCents);

  const commit = () => {
    setEditing(false);
    const cents = clampStakeCents(draft);
    if (cents !== null) {
      onPickStake(cents);
      return;
    }
    if (draft.trim() === "") return; // opened the input and thought better of it — not a refusal
    setRefused(true);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setRefused(false), 700);
  };

  return (
    // pointerdown is stopped on every control so picking a size can never read as the start of a
    // swipe (same rule as the deck's stake chip).
    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
      {STOCK_STAKE_PRESETS_CENTS.map((c) => {
        const active = c === stakeCents;
        return (
          // A real <button>: the div with role="button" answered the mouse and ignored Enter/Space.
          <button
            key={c}
            type="button"
            aria-pressed={active}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPickStake(c); }}
            style={chipStyle(active)}
          >
            <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "#fff" }}>{usd(c)}</div>
            <div style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase" }}>Paper</div>
          </button>
        );
      })}

      {editing ? (
        // Twice the width of a preset while it is open: four chips across a 402px phone leaves ~65px
        // each, which is not enough of a field to type "12.50" into and read it back.
        <div onPointerDown={(e) => e.stopPropagation()} style={{ ...chipStyle(true), flex: 2, display: "flex", alignItems: "center", gap: 3, cursor: "text" }}>
          <span aria-hidden="true" style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "var(--muted)" }}>$</span>
          <input
            autoFocus
            type="text"
            inputMode="decimal"
            placeholder="5"
            aria-label="Custom amount"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            onBlur={commit}
            style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "#fff" }}
          />
        </div>
      ) : (
        <button
          type="button"
          aria-label="Custom amount"
          aria-pressed={custom}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setDraft(""); setEditing(true); }}
          style={chipStyle(custom, refused)}
        >
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: refused ? "var(--no)" : "#fff" }}>{custom ? usd(stakeCents) : "$…"}</div>
          <div style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase" }}>Custom</div>
        </button>
      )}
    </div>
  );
}

// One look for all four chips, so the typed one can never drift from the preset beside it.
function chipStyle(selected: boolean, refused = false): React.CSSProperties {
  return {
    flex: 1,
    margin: 0,
    font: "inherit",
    textAlign: "center",
    background: "rgba(0,0,0,.4)",
    backdropFilter: "blur(6px)",
    border: "1px solid " + (refused ? "var(--no)" : selected ? "var(--gold)" : "var(--line)"),
    padding: "8px 6px",
    borderRadius: 14,
    cursor: "pointer",
  };
}

// The logo, with a two-letter fallback. A broken image URL is a real case (the issuer's CDN is not
// ours), and a broken-image glyph on a card is worse than initials.
function StockLogo({ card }: { card: StockDeckCard }) {
  const [broken, setBroken] = useState(false);
  if (!card.logoUrl || broken) {
    return (
      <div style={{ width: 22, height: 22, borderRadius: "50%", background: "color-mix(in srgb, " + STOCK_ACCENT + " 40%, #000)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "#fff" }}>
        {card.symbol.slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return <img src={card.logoUrl} alt="" width={22} height={22} style={{ borderRadius: "50%" }} onError={() => setBroken(true)} />;
}

// ============================================================================
// StockCardPreview — the next stock card sitting behind the top one. Same resting pose as
// CardPreview (PREVIEW_SCALE / PREVIEW_Y, brightness, pointerEvents none) so the rise animation
// hands off seamlessly when this card is promoted.
// ============================================================================
export const StockCardPreview = memo(function StockCardPreview({ card, stakeCents }: { card: StockDeckCard; stakeCents: number }) {
  return (
    <div style={{ position: "absolute", inset: 0, borderRadius: 26, overflow: "hidden", background: "var(--panel2)", border: "1px solid var(--line)", filter: "brightness(.82)", pointerEvents: "none", transform: `scale(${PREVIEW_SCALE}) translateY(${PREVIEW_Y}px)`, transformOrigin: "center bottom" }}>
      <StockCardFace card={card} yesP={0} noP={0} skipP={0} stakeCents={stakeCents} onPickStake={NOOP} walletLinked={false} consented={false} stocksUsdCents={null} />
    </div>
  );
});

// ============================================================================
// StockDeckCard — the interactive top card. Reuses SwipeShell verbatim, so the physics, the rise
// animation and the tap detection are the SAME code the prediction deck runs.
// ============================================================================
export function StockDeckCard({
  card,
  busy,
  onAction,
  stakeCents,
  onPickStake,
  onBuyReal,
  buyRealBusy,
  walletLinked,
  consented,
  stocksUsdCents,
  onOpenWallet,
}: {
  card: StockDeckCard;
  busy?: boolean;
  onAction: (a: SwipeAction) => void;
  stakeCents: number;
  onPickStake: (c: number) => void;
  onBuyReal?: () => void;
  buyRealBusy?: boolean;
  walletLinked: boolean;
  consented: boolean;
  stocksUsdCents: number | null;
  onOpenWallet?: () => void;
}) {
  return (
    <SwipeShell busy={busy} onAction={onAction} onTap={() => {}}>
      {({ yesP, noP, skipP }) => (
        <StockCardFace card={card} yesP={yesP} noP={noP} skipP={skipP} stakeCents={stakeCents} onPickStake={onPickStake} onBuyReal={onBuyReal} buyRealBusy={buyRealBusy} walletLinked={walletLinked} consented={consented} stocksUsdCents={stocksUsdCents} onOpenWallet={onOpenWallet} />
      )}
    </SwipeShell>
  );
}

// Local copy of the deck's Stamp look. Deliberately NOT exported from DeckCard: the two cards share
// a visual language, not a component — a stock stamp that drifted from the deck's would be a bug
// nobody notices until the two are side by side.
function StockStamp({ label, color, o, s, pos, rot }: { label: string; color: string; o: number; s: number; pos: React.CSSProperties; rot: number }) {
  return (
    <div style={{
      position: "absolute", ...pos, border: `5px solid ${color}`, color,
      fontFamily: "var(--df)", fontSize: 40, padding: "2px 16px", borderRadius: 12,
      transform: `rotate(${rot}deg) scale(${s})`, opacity: o, maxWidth: 240,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      boxShadow: `0 0 24px color-mix(in srgb,${color} 40%,transparent)`, textAlign: "center",
    } as React.CSSProperties}>{label}</div>
  );
}
