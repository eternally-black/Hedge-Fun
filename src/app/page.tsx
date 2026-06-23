"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useApi } from "./useApi";

const PRIVY_ON = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

type Me = {
  balanceCents: number;
  points: { total: number; bonusFromX2: number };
  swipes: { used: number; cap: number };
  shards: number;
  artifacts: number;
  streak: { level: number; state: string };
  loginMarkedToday: boolean;
};
type Card = {
  id: string;
  question: string;
  yesPriceBp: number;
  noPriceBp: number;
  resolutionDeadline: string;
};

const usd = (cents: number) => `$${(cents / 100).toFixed(0)}`;
const pct = (bp: number) => `${(bp / 100).toFixed(0)}%`;

export default function Home() {
  if (!PRIVY_ON) return <ConfigNotice />;
  return <App />;
}

function ConfigNotice() {
  return (
    <main style={S.main}>
      <h1>Hedge Fun</h1>
      <p style={{ color: "#9aa3b2" }}>
        Set <code>NEXT_PUBLIC_PRIVY_APP_ID</code> and <code>PRIVY_APP_SECRET</code> in{" "}
        <code>.env.local</code> to enable login.
      </p>
    </main>
  );
}

function App() {
  const { ready, authenticated, login, logout } = usePrivy();
  const api = useApi();
  const [me, setMe] = useState<Me | null>(null);
  const [deck, setDeck] = useState<Card[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [m, d] = await Promise.all([api("/api/me"), api("/api/deck")]);
    setMe(m);
    setDeck(d.cards);
  }, [api]);

  useEffect(() => {
    if (authenticated) refresh().catch(console.error);
  }, [authenticated, refresh]);

  const gm = useCallback(async () => {
    setBusy(true);
    try {
      await api("/api/login-mark", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [api, refresh]);

  const swipe = useCallback(
    async (card: Card, side: "YES" | "NO") => {
      setBusy(true);
      try {
        await api("/api/swipe", { method: "POST", body: JSON.stringify({ marketId: card.id, side }) });
        setDeck((d) => d.filter((c) => c.id !== card.id)); // advance the deck
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [api, refresh],
  );

  if (!ready) return <main style={S.main}>Loading…</main>;

  if (!authenticated) {
    return (
      <main style={S.main}>
        <h1>Hedge Fun</h1>
        <p style={{ color: "#9aa3b2" }}>Swipe real markets. Play money. Collect points.</p>
        <button style={S.primary} onClick={login}>
          Log in
        </button>
      </main>
    );
  }

  const top = deck[0];

  return (
    <main style={S.main}>
      <div style={S.bar}>
        <Stat label="Balance" value={me ? usd(me.balanceCents) : "—"} />
        <Stat label="Points" value={me ? String(me.points.total) : "—"} />
        <Stat label="Streak" value={me ? `🔥 ${me.streak.level}` : "—"} />
        <Stat label="Shards" value={me ? `${me.shards}/20` : "—"} />
        <Stat label="Artifacts" value={me ? String(me.artifacts) : "—"} />
        <button style={S.ghost} onClick={logout}>
          Log out
        </button>
      </div>

      <button style={me?.loginMarkedToday ? S.ghostWide : S.primary} onClick={gm} disabled={busy || me?.loginMarkedToday}>
        {me?.loginMarkedToday ? "GM ✓ (today counted)" : "GM — claim daily bonus"}
      </button>

      <p style={{ color: "#9aa3b2", margin: "8px 0" }}>
        Swipes today: {me ? `${me.swipes.used}/${me.swipes.cap}` : "—"}
      </p>

      {top ? (
        <div style={S.card}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>{top.question}</div>
          <div style={{ color: "#9aa3b2", marginBottom: 16 }}>
            Yes {pct(top.yesPriceBp)} · No {pct(top.noPriceBp)} · resolves{" "}
            {new Date(top.resolutionDeadline).toLocaleString()}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button style={S.no} disabled={busy} onClick={() => swipe(top, "NO")}>
              ✗ No
            </button>
            <button style={S.yes} disabled={busy} onClick={() => swipe(top, "YES")}>
              ✓ Yes
            </button>
          </div>
        </div>
      ) : (
        <div style={S.card}>
          <p style={{ color: "#9aa3b2" }}>
            Deck empty. Run <code>npm run refresh-deck</code> to load blitz markets.
          </p>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "#9aa3b2", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 560, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 12 },
  bar: { display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" },
  primary: { padding: "14px 20px", fontSize: 16, fontWeight: 600, background: "#6366f1", color: "#fff", border: 0, borderRadius: 12, cursor: "pointer" },
  ghost: { padding: "8px 12px", background: "transparent", color: "#9aa3b2", border: "1px solid #2a3040", borderRadius: 8, cursor: "pointer" },
  ghostWide: { padding: "14px 20px", fontSize: 16, background: "#1a1f2e", color: "#6ee7a8", border: "1px solid #2a3040", borderRadius: 12 },
  card: { background: "#141925", border: "1px solid #2a3040", borderRadius: 16, padding: 24 },
  yes: { flex: 1, padding: "16px", fontSize: 16, fontWeight: 700, background: "#16a34a", color: "#fff", border: 0, borderRadius: 12, cursor: "pointer" },
  no: { flex: 1, padding: "16px", fontSize: 16, fontWeight: 700, background: "#dc2626", color: "#fff", border: 0, borderRadius: 12, cursor: "pointer" },
};
