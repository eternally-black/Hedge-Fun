"use client";

import { useEffect, useState } from "react";
import { useApi } from "../../useApi";
import type { AdminLeaderboardResponse } from "@/lib/api-types";
import { AdminLeaderboardTable } from "./AdminLeaderboardTable";

// Private admin growth dashboard. Standalone desktop route — NOT part of the phone shell (page.tsx
// Screen union / BottomNav). Protection is the API 403: a non-admin's token gets rejected server-side
// and we render "Not authorized". The data payload carries all 3 windows so the table never refetches.
export default function AdminLeaderboardPage() {
  const api = useApi();
  const [data, setData] = useState<AdminLeaderboardResponse | null>(null);
  const [error, setError] = useState<"forbidden" | "other" | null>(null);

  useEffect(() => {
    api("/api/admin/leaderboard")
      .then((d) => setData(d as AdminLeaderboardResponse))
      .catch((e) => {
        // 401 (no/invalid token → logged out) and 403 (authed, not admin) both = "not authorized".
        const s = (e as { status?: number }).status;
        setError(s === 403 || s === 401 ? "forbidden" : "other");
      });
  }, [api]); // api is stable (useApi useCallback)

  if (error) {
    return (
      <Center>
        {error === "forbidden" ? "Not authorized." : "Couldn’t load the leaderboard."}
      </Center>
    );
  }
  if (!data) return <Center>Loading…</Center>;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: "20px 24px 40px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 30, marginBottom: 2 }}>Admin · Leaderboard</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 18 }}>
          Private · {data.rows.length} users · generated {new Date(data.generatedAt).toLocaleString()}
        </div>
        <AdminLeaderboardTable rows={data.rows} />
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 14 }}>
      {children}
    </div>
  );
}
