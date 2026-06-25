"use client";

import { useEffect, useState } from "react";
import { num } from "../ui";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
type Row = { rank: number; userId: string; handle: string; points: number };
type Board = { top: Row[]; me: { rank: number | null; points: number } };

// PRIVATE leaderboard (Q11): auth-gated, never publicly scrapable. Reads /api/leaderboard, which
// ranks by effective (multiplier-applied) points. The owner tags top accounts on X manually;
// there is no public board. Ported visual from app design.
export function LeaderboardScreen({ api }: { api: Api }) {
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    api("/api/leaderboard").then((b) => setBoard(b as Board)).catch(console.error);
  }, [api]);

  if (!board) {
    return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Loading…</div>;
  }

  const podium = board.top.slice(0, 3);
  const rest = board.top.slice(3);
  const heights = [60, 80, 46];
  const rings = ["#c0c0c8", "var(--gold)", "#c98a4a"];
  // podium display order: 2nd, 1st, 3rd
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "8px 16px 20px" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 30 }}>Leaderboard</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Private · top farmers by points</div>
      </div>

      {order.length > 0 && (
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 8, marginTop: 18 }}>
          {order.map((p) => {
            const place = podium.indexOf(p); // 0,1,2 -> rank 1,2,3
            return (
              <div key={p.userId} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 46, height: 46, borderRadius: "50%", background: "linear-gradient(135deg,#555,#222)", border: `2px solid ${rings[place]}`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "#fff", fontSize: 13 }}>{p.handle.slice(0, 2).toUpperCase()}</div>
                <div style={{ fontSize: 11, fontWeight: 700, marginTop: 5, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.handle}</div>
                <div style={{ fontFamily: "var(--nf)", fontSize: 11, color: "var(--energy)" }}>{num(p.points)}</div>
                <div style={{ width: "100%", height: heights[place], marginTop: 7, borderRadius: "10px 10px 0 0", background: `linear-gradient(180deg,${rings[place]},var(--panel))`, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 6, fontFamily: "var(--df)", fontSize: 18, color: "#fff" }}>{place + 1}</div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 7 }}>
        {rest.map((b) => (
          <Row key={b.userId} row={b} me={false} />
        ))}
        {board.me.rank !== null && !board.top.some((r) => r.rank === board.me.rank) && (
          <Row row={{ rank: board.me.rank, userId: "me", handle: "you", points: board.me.points }} me />
        )}
      </div>
    </div>
  );
}

function Row({ row, me }: { row: Row; me: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, background: me ? "color-mix(in srgb,var(--energy) 12%,var(--panel))" : "var(--panel)", border: `1px solid ${me ? "var(--energy)" : "var(--line)"}`, borderRadius: 14, padding: "10px 13px" }}>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: "var(--muted)", width: 30 }}>{row.rank}</div>
      <div style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg,#555,#222)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, color: "#fff" }}>{row.handle.slice(0, 2).toUpperCase()}</div>
      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.handle}{me ? " (you)" : ""}</div>
      <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, color: "var(--energy)" }}>{num(row.points)}</span>
    </div>
  );
}
