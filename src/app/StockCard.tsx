"use client";

import { memo, useState } from "react";
import { usd } from "./ui";
import { STOCK_STAKE_PRESETS_CENTS } from "@/lib/config";
import { SwipeShell, PREVIEW_SCALE, PREVIEW_Y, useTick, type SwipeAction } from "./DeckCard";
import type { StockDeckCard } from "@/lib/api-types";

// The stock deck's accent. Deliberately NOT one of the category colors: a stock card is a different
// species from a prediction card (it never resolves, it has no two sides), and it must not read as
// one of the market categories it sits beside.
export const STOCK_ACCENT = "#34d399";

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
};

export const StockCardFace = memo(function StockCardFace({ card, yesP, noP, skipP, stakeCents, onPickStake, onBuyReal, buyRealBusy, walletLinked, consented }: FaceProps) {
  // The price pulses exactly like the odds do on a prediction card: a number that changes between
  // frames reads as a number that never moves. Same hook, same animation names.
  const priceTick = useTick(card.priceCents);
  const stamp = (p: number) => ({ o: Math.max(0, Math.min(1, (p - 0.15) / 0.5)), s: 0.6 + 0.4 * Math.min(1, p) });
  const ys = stamp(yesP), ns = stamp(noP), ks = stamp(skipP);
  const change = card.change24hBp;
  const changeText = change == null ? "—" : `${change >= 0 ? "+" : "−"}${(Math.abs(change) / 100).toFixed(2)}%`;
  const changeColor = change == null ? "var(--muted)" : change >= 0 ? "var(--yes)" : "var(--no)";
  const buyLabel = buyRealBusy
    ? "Buying…"
    : !walletLinked
      ? "Connect Phantom to buy on Solana"
      : !consented
        ? "Accept xStocks terms to buy"
        : "◎ Buy on Solana";

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
          <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,.6)", letterSpacing: ".02em" }}>{card.underlying}</div>
          <div style={{ marginTop: 14, display: "flex", alignItems: "baseline", gap: 10 }}>
            <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 40, lineHeight: 1, color: "#fff", animation: priceTick }}>{usd(card.priceCents)}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: changeColor }}>{changeText}</span>
              <span style={{ fontSize: 10, color: "var(--muted)", letterSpacing: ".08em", textTransform: "uppercase" }}>24h</span>
            </div>
          </div>
        </div>

        {/* stake chips — the amount a paper buy spends. pointerdown is stopped so picking a size can
            never read as the start of a swipe (same rule as the deck's stake chip). */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {STOCK_STAKE_PRESETS_CENTS.map((c) => {
            const active = c === stakeCents;
            return (
              <div
                key={c}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onPickStake(c); }}
                style={{
                  flex: 1,
                  textAlign: "center",
                  background: "rgba(0,0,0,.4)",
                  backdropFilter: "blur(6px)",
                  border: "1px solid " + (active ? "var(--gold)" : "var(--line)"),
                  padding: "8px 6px",
                  borderRadius: 14,
                  cursor: "pointer",
                }}
              >
                <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "#fff" }}>{usd(c)}</div>
                <div style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase" }}>Paper</div>
              </div>
            );
          })}
        </div>

        {card.tradable && onBuyReal && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onBuyReal(); }}
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
      <StockCardFace card={card} yesP={0} noP={0} skipP={0} stakeCents={stakeCents} onPickStake={() => {}} walletLinked={false} consented={false} />
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
}) {
  return (
    <SwipeShell busy={busy} onAction={onAction} onTap={() => {}}>
      {({ yesP, noP, skipP }) => (
        <StockCardFace card={card} yesP={yesP} noP={noP} skipP={skipP} stakeCents={stakeCents} onPickStake={onPickStake} onBuyReal={onBuyReal} buyRealBusy={buyRealBusy} walletLinked={walletLinked} consented={consented} />
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
