"use client";

import { memo, useEffect, useState } from "react";
import { type Screen } from "../ui";

const ITEMS: { key: Screen; glyph: string; label: string }[] = [
  { key: "deck", glyph: "⚡", label: "Deck" },
  { key: "football", glyph: "⚽", label: "Cup" }, // World Cup hub (live scoreboard)
  { key: "hedge", glyph: "🛡", label: "Hedge" }, // S1 wallet hedge (phase 2)
  { key: "feed", glyph: "≋", label: "Feed" }, // DEV-ONLY (testing). Real users reach the feed via the post-cap Deck tab.
  { key: "vault", glyph: "◆", label: "Vault" },
  { key: "invite", glyph: "＋", label: "Invite" },
  { key: "you", glyph: "◉", label: "You" },
];
// NB: GM lives in the top HUD (the streak chip), not here. Deck and Feed share ONE tab — see below.

// Time until the next 00:00 UTC — when the daily swipe cap (DailyCounter utcDay) rolls over and the
// deck reopens. Ticks every 30s (minute-grained label, so per-second is wasted renders). Lazy init =
// correct first paint; the setState lives in the interval callback (no setState-in-effect cascade).
function useDeckResetCountdown(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  const min = Math.max(0, Math.floor((next - now) / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : "<1m";
}

// The Deck tab is the SINGLE entry to both the deck and the post-cap feed: while you have swipes it
// shows the deck; once the cap is spent (deckLocked) tapping it opens the feed instead, and its label
// becomes the countdown to the next deck (00:00 UTC). No separate Feed tab for users — only dev gets
// one (devFeed) so the unlimited-swipe dev account can still reach the feed for testing.
export const BottomNav = memo(function BottomNav({ screen, onNav, deckLocked, devFeed }: { screen: Screen; onNav: (s: Screen) => void; deckLocked: boolean; devFeed: boolean }) {
  const resetIn = useDeckResetCountdown();
  const items = devFeed ? ITEMS : ITEMS.filter((it) => it.key !== "feed");
  return (
    <div style={{ position: "relative", zIndex: 40, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "10px 8px 22px", background: "linear-gradient(0deg,var(--bg) 60%,transparent)", borderTop: "1px solid var(--line)" }}>
      {items.map((it) => {
        const isDeck = it.key === "deck";
        const deckTimer = isDeck && deckLocked; // locked deck → show the reset countdown, still tappable (→ feed)
        // The Deck tab stays lit while you're on the deck OR (for users) the feed it routes into.
        const active = isDeck ? screen === "deck" || (screen === "feed" && !devFeed) : screen === it.key;
        const label = deckTimer ? resetIn : it.label;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onNav(it.key)}
            aria-label={deckTimer ? `Feed — fresh deck in ${resetIn}` : it.label}
            aria-current={active ? "page" : undefined}
            style={{ background: "none", border: "none", padding: 0, margin: 0, font: "inherit", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", color: active ? "var(--energy)" : "var(--muted)" }}
          >
            <span aria-hidden="true" style={{ fontSize: 20 }}>{it.glyph}</span>
            <span style={{ fontSize: 9, letterSpacing: ".06em", textTransform: deckTimer ? "none" : "uppercase", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
});
