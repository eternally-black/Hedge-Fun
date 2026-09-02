"use client";

import { useCallback, useMemo, useState } from "react";
import { num } from "../../ui";
import type { AdminLeaderboardRow } from "@/lib/api-types";

type Window = "all" | "week" | "today";
type SortKey = "rank" | "points" | "streak" | "lastActive" | "handle";
type SortDir = "asc" | "desc";

// Points for the active window. Exported pure so the unit test can pin window selection.
export function pointsFor(r: AdminLeaderboardRow, window: Window): number {
  return window === "all" ? r.pointsAll : window === "week" ? r.pointsWeek : r.pointsToday;
}

// Pure filter + sort, extracted so it's testable without React. Never mutates `rows` (.toSorted).
export function deriveRows(
  rows: AdminLeaderboardRow[],
  c: { window: Window; sortKey: SortKey; sortDir: SortDir; query: string; hasTwitterOnly: boolean; minPoints: number },
): AdminLeaderboardRow[] {
  const q = c.query.trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      (!c.hasTwitterOnly || r.hasTwitter) &&
      pointsFor(r, c.window) >= c.minPoints &&
      (!q || r.handle.toLowerCase().includes(q) || r.userId.toLowerCase().includes(q)),
  );
  const dir = c.sortDir === "asc" ? 1 : -1;
  // Copy-then-sort = immutable (never mutate `rows`). .toSorted() would need lib:es2023; the spread
  // is the same guarantee without a global tsconfig bump.
  return [...filtered].sort((a, b) => {
    switch (c.sortKey) {
      case "points":
        return (pointsFor(a, c.window) - pointsFor(b, c.window)) * dir;
      case "streak":
        return (a.streakLevel - b.streakLevel) * dir;
      case "lastActive":
        return ((a.lastActive ? Date.parse(a.lastActive) : 0) - (b.lastActive ? Date.parse(b.lastActive) : 0)) * dir;
      case "handle":
        return a.handle.localeCompare(b.handle) * dir;
      default: // "rank" = canonical all-time rank
        return (a.rank - b.rank) * dir;
    }
  });
}

export function AdminLeaderboardTable({ rows }: { rows: AdminLeaderboardRow[] }) {
  // useState holds ONLY the controls (primitives). Derived data is computed during render, never stored.
  const [window, setWindow] = useState<Window>("all");
  const [sortKey, setSortKey] = useState<SortKey>("points");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [hasTwitterOnly, setHasTwitterOnly] = useState(false);
  const [minPoints, setMinPoints] = useState(0);

  // The expensive pass, memoized on primitive deps + the stable `rows` prop (derive-during-render).
  const view = useMemo(
    () => deriveRows(rows, { window, sortKey, sortDir, query, hasTwitterOnly, minPoints }),
    [rows, window, sortKey, sortDir, query, hasTwitterOnly, minPoints],
  );

  // Click a header: same key flips dir, new key starts desc. Functional setState keeps it stable.
  const onSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      setSortDir((d) => (prevKey === key ? (d === "desc" ? "asc" : "desc") : "desc"));
      return key;
    });
  }, []);

  return (
    <div style={{ userSelect: "text" }}>
      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 4, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10, padding: 3 }}>
          {(["all", "week", "today"] as const).map((w) => (
            <button key={w} onClick={() => setWindow(w)} style={tabStyle(window === w)}>
              {w === "all" ? "All-time" : w === "week" ? "This week" : "Today"}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search handle / id…"
          style={inputStyle}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)" }}>
          <input type="checkbox" checked={hasTwitterOnly} onChange={(e) => setHasTwitterOnly(e.target.checked)} />
          Has Twitter
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)" }}>
          Min pts
          <input
            type="number"
            min={0}
            value={minPoints}
            onChange={(e) => setMinPoints(Math.max(0, Number(e.target.value) || 0))}
            style={{ ...inputStyle, width: 80 }}
          />
        </label>
        <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: "auto" }}>{view.length} shown</span>
      </div>

      {/* Table */}
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 6px", fontSize: 13 }}>
        <thead>
          <tr>
            <Th onClick={() => onSort("rank")} active={sortKey === "rank"} dir={sortDir} style={{ width: 50 }}>#</Th>
            <Th onClick={() => onSort("handle")} active={sortKey === "handle"} dir={sortDir}>User</Th>
            <Th>Twitter</Th>
            <Th onClick={() => onSort("points")} active={sortKey === "points"} dir={sortDir} style={{ textAlign: "right" }}>Points</Th>
            <Th onClick={() => onSort("streak")} active={sortKey === "streak"} dir={sortDir} style={{ textAlign: "right" }}>Streak</Th>
            <Th onClick={() => onSort("lastActive")} active={sortKey === "lastActive"} dir={sortDir}>Last active</Th>
          </tr>
        </thead>
        <tbody>
          {view.map((r) => (
            // content-visibility lets the browser skip layout for off-screen rows on long lists.
            <tr key={r.userId} style={{ background: "var(--panel)", contentVisibility: "auto", containIntrinsicSize: "44px" }}>
              <Td style={{ borderRadius: "12px 0 0 12px", fontFamily: "var(--nf)", color: "var(--muted)" }}>{r.rank}</Td>
              <Td>
                <div style={{ fontWeight: 600 }}>{r.handle}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--nf)" }}>{r.userId.slice(-6)}</div>
              </Td>
              <Td>
                {r.twitterHandle ? (
                  <a
                    href={`https://twitter.com/${encodeURIComponent(r.twitterHandle)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--energy)", textDecoration: "none", fontWeight: 600 }}
                  >
                    @{r.twitterHandle}
                  </a>
                ) : (
                  <span style={{ color: "var(--muted)" }}>—</span>
                )}
              </Td>
              <Td style={{ textAlign: "right", fontFamily: "var(--nf)", fontWeight: 700, color: "var(--energy)" }}>
                {num(pointsFor(r, window))}
              </Td>
              <Td style={{ textAlign: "right", fontFamily: "var(--nf)" }}>{r.streakLevel}</Td>
              <Td style={{ borderRadius: "0 12px 12px 0", color: "var(--muted)", whiteSpace: "nowrap" }}>
                {r.lastActive ? new Date(r.lastActive).toLocaleDateString() : "—"}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
  style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  dir?: SortDir;
  style?: React.CSSProperties;
}) {
  return (
    <th
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "0 12px 6px",
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        color: active ? "var(--text)" : "var(--muted)",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
    >
      {children}
      {active ? (dir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 12px", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", ...style }}>{children}</td>;
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 7,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    background: active ? "var(--energy)" : "transparent",
    color: active ? "#0a0a0f" : "var(--muted)",
  };
}

const inputStyle: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "7px 11px",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};
