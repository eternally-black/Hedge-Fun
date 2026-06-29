"use client";

import { memo, useEffect, useState } from "react";
import { type Screen } from "../ui";

const ITEMS: { key: Screen; glyph: string; label: string }[] = [
  { key: "deck", glyph: "⚡", label: "Deck" },
  { key: "football", glyph: "⚽", label: "Cup" }, // World Cup hub (live scoreboard)
  { key: "feed", glyph: "≋", label: "Feed" }, // only rendered once unlocked (post-cap) — see feedUnlocked
  { key: "gm", glyph: "☀", label: "GM" },
  { key: "vault", glyph: "◆", label: "Vault" },
  { key: "invite", glyph: "＋", label: "Invite" },
  { key: "you", glyph: "◉", label: "You" },
];

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

// deckLocked: a non-dev user who spent their daily swipe cap. The Deck tab then goes inactive and
// shows the countdown to the next deck (00:00 UTC) instead of "Deck" — the feed is home until then.
export const BottomNav = memo(function BottomNav({ screen, onNav, feedUnlocked, deckLocked }: { screen: Screen; onNav: (s: Screen) => void; feedUnlocked: boolean; deckLocked: boolean }) {
  const resetIn = useDeckResetCountdown();
  const items = feedUnlocked ? ITEMS : ITEMS.filter((it) => it.key !== "feed");
  return (
    <div style={{ position: "relative", zIndex: 40, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "10px 8px 22px", background: "linear-gradient(0deg,var(--bg) 60%,transparent)", borderTop: "1px solid var(--line)" }}>
      {items.map((it) => {
        const locked = it.key === "deck" && deckLocked;
        const active = !locked && screen === it.key;
        const label = locked ? resetIn : it.label;
        return (
          <button
            key={it.key}
            type="button"
            onClick={locked ? undefined : () => onNav(it.key)}
            disabled={locked}
            aria-label={locked ? `Deck refreshes in ${resetIn}` : it.label}
            aria-current={active ? "page" : undefined}
            style={{ background: "none", border: "none", padding: 0, margin: 0, font: "inherit", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: locked ? "default" : "pointer", color: active ? "var(--energy)" : "var(--muted)", opacity: locked ? 0.45 : 1 }}
          >
            <span aria-hidden="true" style={{ fontSize: 20 }}>{it.glyph}</span>
            <span style={{ fontSize: 9, letterSpacing: ".06em", textTransform: locked ? "none" : "uppercase", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
});
