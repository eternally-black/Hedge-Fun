"use client";

import { useEffect, useState } from "react";
import type { ResultsResponse, ResultRow } from "@/lib/api-types";
import { catOfResult, resultMeta, deltaStr } from "../ui";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The notifications inbox: a calm, scannable feed of every settled call, newest first. Opening it
// marks everything seen (clears the HUD bell). "Replay" re-runs the dopamine reveal. Lean-back
// counterpart to the reveal overlay — both read /api/results, this one just lists it.
export function NotificationsScreen({ api, onSeen, onReplay }: { api: Api; onSeen: () => void; onReplay: () => void }) {
  const [rows, setRows] = useState<ResultRow[] | null>(null);

  // Load the feed, then mark seen. Marking is fire-and-forget (the badge already cleared locally
  // via onSeen); a failed mark just means the badge reappears on next /api/me — acceptable.
  useEffect(() => {
    let alive = true;
    api("/api/results")
      .then((r) => { if (alive) setRows((r as ResultsResponse).rows); })
      .catch(console.error);
    onSeen();
    api("/api/results/seen", { method: "POST" }).catch(() => { /* badge re-syncs from /api/me */ });
    return () => { alive = false; };
  }, [api, onSeen]);

  if (!rows) {
    return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Loading…</div>;
  }

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>Results</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>Every call you&apos;ve made, settled.</div>
        {rows.length > 0 && (
          <button type="button" onClick={onReplay} aria-label="Replay results reveal" style={{ margin: 0, font: "inherit", marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, background: "color-mix(in srgb,var(--energy) 16%,var(--panel))", border: "1px solid color-mix(in srgb,var(--energy) 40%,var(--line))", padding: "8px 12px", borderRadius: 12, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>▸ Replay</button>
        )}
      </div>

      {rows.length === 0 ? (
        <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13 }}>
          Nothing settled yet. Swipe some cards — results land here once markets resolve.
        </div>
      ) : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((n) => <InboxRow key={n.id} row={n} />)}
        </div>
      )}
    </div>
  );
}

function InboxRow({ row }: { row: ResultRow }) {
  const cat = catOfResult(row);
  const m = resultMeta(row.status);
  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  return (
    <div style={{ display: "flex", gap: 11, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 13px" }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: `color-mix(in srgb,${m.accent} 20%,var(--panel2))`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{cat.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.25, textWrap: "pretty" }}>{row.question}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
          Your call <span style={{ color: sideColor, fontWeight: 700 }}>{row.side}</span> · {row.outcome}
        </div>
        {row.verified ? (
          <a
            href={row.onchainRef ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 5, fontSize: 10, fontWeight: 700, color: "var(--yes)", textDecoration: "none" }}
          >
            ⛓ Solana-anchored score
          </a>
        ) : null}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: m.accent }}>{deltaStr(row.status, row.deltaCents)}</div>
        <div style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: m.accent, fontWeight: 700, marginTop: 2 }}>{m.tag}</div>
        {row.shards > 0 && <div style={{ fontSize: 10, color: "var(--gold)", marginTop: 2 }}>+{row.shards} ◆</div>}
      </div>
    </div>
  );
}
