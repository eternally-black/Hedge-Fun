"use client";

import { memo } from "react";
import { type Screen } from "../ui";

const ITEMS: { key: Screen; glyph: string; label: string }[] = [
  { key: "deck", glyph: "⚡", label: "Deck" },
  { key: "gm", glyph: "☀", label: "GM" },
  { key: "vault", glyph: "◆", label: "Vault" },
  { key: "invite", glyph: "＋", label: "Invite" },
  { key: "you", glyph: "◉", label: "You" },
];

export const BottomNav = memo(function BottomNav({ screen, onNav }: { screen: Screen; onNav: (s: Screen) => void }) {
  return (
    <div style={{ position: "relative", zIndex: 40, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "10px 8px 22px", background: "linear-gradient(0deg,var(--bg) 60%,transparent)", borderTop: "1px solid var(--line)" }}>
      {ITEMS.map((it) => {
        // "leaderboard" lives under the You tab, so it counts as active there.
        const active = screen === it.key || (it.key === "you" && screen === "leaderboard");
        return (
          <div key={it.key} onClick={() => onNav(it.key)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", color: active ? "var(--energy)" : "var(--muted)" }}>
            <span style={{ fontSize: 20 }}>{it.glyph}</span>
            <span style={{ fontSize: 9, letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 700 }}>{it.label}</span>
          </div>
        );
      })}
    </div>
  );
});
