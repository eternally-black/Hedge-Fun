"use client";

import { memo } from "react";
import { type Screen } from "../ui";

const ITEMS: { key: Screen; glyph: string; label: string }[] = [
  { key: "deck", glyph: "⚡", label: "Deck" },
  { key: "feed", glyph: "≋", label: "Feed" }, // only rendered once unlocked (post-cap) — see feedUnlocked
  { key: "gm", glyph: "☀", label: "GM" },
  { key: "vault", glyph: "◆", label: "Vault" },
  { key: "invite", glyph: "＋", label: "Invite" },
  { key: "you", glyph: "◉", label: "You" },
];

// feedUnlocked: the feed becomes a destination only after the daily swipe cap is spent (dev always).
// Until then the Feed tab is hidden so it can't be entered early.
export const BottomNav = memo(function BottomNav({ screen, onNav, feedUnlocked }: { screen: Screen; onNav: (s: Screen) => void; feedUnlocked: boolean }) {
  const items = feedUnlocked ? ITEMS : ITEMS.filter((it) => it.key !== "feed");
  return (
    <div style={{ position: "relative", zIndex: 40, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "10px 8px 22px", background: "linear-gradient(0deg,var(--bg) 60%,transparent)", borderTop: "1px solid var(--line)" }}>
      {items.map((it) => {
        const active = screen === it.key;
        return (
          <button key={it.key} type="button" onClick={() => onNav(it.key)} aria-label={it.label} aria-current={active ? "page" : undefined} style={{ background: "none", border: "none", padding: 0, margin: 0, font: "inherit", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", color: active ? "var(--energy)" : "var(--muted)" }}>
            <span aria-hidden="true" style={{ fontSize: 20 }}>{it.glyph}</span>
            <span style={{ fontSize: 9, letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 700 }}>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
});
