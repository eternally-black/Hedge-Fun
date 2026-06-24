"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useApi } from "./useApi";
import { SwipeCard, type SwipeAction } from "./SwipeCard";

const PRIVY_ON = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

type Me = {
  balanceCents: number;
  points: { total: number; bonusFromX2: number };
  swipes: { used: number; cap: number };
  skips: { usedToday: number; nextIsFree: boolean; shardCost: number };
  shards: number;
  artifacts: number;
  streak: { level: number; state: string };
  loginMarkedToday: boolean;
};
type Card = {
  id: string;
  question: string;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
  yesPriceBp: number;
  noPriceBp: number;
  resolutionDeadline: string;
};

const usd = (cents: number) => `$${(cents / 100).toFixed(0)}`;
// Price as Polymarket shows it: cents per share (= probability). A side priced at 0.515 is 52¢.
// We deliberately show CENTS, not a percentage — that's how prediction markets quote, and the
// app's goal is to teach that. The two sides need NOT sum to 100¢ (the spread is real), so we
// never normalise. 1bp = 0.01¢; show whole cents (Polymarket-style), .5 kept when present.
const cents = (bp: number) => {
  const c = bp / 100; // bp -> cents (5150bp = 51.5¢)
  return `${Number.isInteger(c) ? c : c.toFixed(1)}¢`;
};

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

  // Top up the deck when it runs low so the user never hits an empty card mid-session. Called
  // from the swipe handler (not an effect — this is interaction-driven, so it belongs in the
  // event per react best practices). topping ref guards against overlapping top-ups.
  const topping = useRef(false);
  const topUpIfLow = useCallback(
    async (remaining: number) => {
      if (remaining > 3 || topping.current) return;
      topping.current = true;
      try {
        const d: { cards: Card[] } = await api("/api/deck");
        setDeck((cur) => {
          const have = new Set(cur.map((c) => c.id));
          return [...cur, ...d.cards.filter((c) => !have.has(c.id))];
        });
      } catch (e) {
        console.error(e);
      } finally {
        topping.current = false;
      }
    },
    [api],
  );

  // Drop the swiped/skipped card and advance to the next. SKIP posts to /api/skip (first free,
  // then 1 shard; blocked with no shards). YES/NO post a bet. The card is removed and replaced
  // by the next in the deck — never re-shown.
  const act = useCallback(
    async (card: Card, action: SwipeAction) => {
      setBusy(true);
      try {
        if (action === "SKIP") {
          // Only advance if the skip is allowed (a paid skip with no shards is blocked: 402).
          await api("/api/skip", { method: "POST" });
        } else {
          await api("/api/swipe", {
            method: "POST",
            body: JSON.stringify({ marketId: card.id, side: action }),
          });
        }
        setDeck((d) => {
          const next = d.filter((c) => c.id !== card.id);
          void topUpIfLow(next.length);
          return next;
        });
        await refresh(); // stats (balance, shards, skip counter)
      } catch (e) {
        // 409 on a swipe = already bet this market (it's done) -> advance anyway, don't trap the
        // user on it. 402 on a paid skip (no shards) keeps the card -> SwipeCard springs back.
        if (action !== "SKIP" && (e as { status?: number }).status === 409) {
          setDeck((d) => {
            const next = d.filter((c) => c.id !== card.id);
            void topUpIfLow(next.length);
            return next;
          });
        } else {
          console.error(e);
        }
      } finally {
        setBusy(false);
      }
    },
    [api, refresh, topUpIfLow],
  );

  if (!ready) return <main style={S.main}>Loading…</main>;

  if (!authenticated) {
    return (
      <main style={S.main}>
        <h1>Hedge Fun</h1>
        <p style={{ color: "#9aa3b2" }}>Test app — swipe real markets, play money, stack points.</p>
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
        // key=top.id so a fresh SwipeCard mounts per card (resets drag state cleanly).
        <SwipeCard key={top.id} onAction={(a) => act(top, a)} disabled={busy}>
          <div style={S.card}>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{top.question}</div>
            <div style={{ color: "#9aa3b2", marginBottom: 20, fontSize: 13 }}>
              resolves {new Date(top.resolutionDeadline).toLocaleString()}
            </div>
            {/* Polymarket-style: each side's button shows its label + price in cents (= the
                share price you'd pay). No percentage row — cents IS the probability, and the
                two sides need not sum to 100¢. */}
            <div style={{ display: "flex", gap: 12 }}>
              <button style={S.no} disabled={busy} onClick={() => act(top, "NO")}>
                <span>{top.outcomeNoLabel}</span>
                <span style={S.price}>{cents(top.noPriceBp)}</span>
              </button>
              <button style={S.yes} disabled={busy} onClick={() => act(top, "YES")}>
                <span>{top.outcomeYesLabel}</span>
                <span style={S.price}>{cents(top.yesPriceBp)}</span>
              </button>
            </div>
            <button style={S.skip} disabled={busy} onClick={() => act(top, "SKIP")}>
              {me?.skips.nextIsFree
                ? "Skip (free today)"
                : `Skip (−${me?.skips.shardCost ?? 1} shard${me && me.shards < (me.skips.shardCost ?? 1) ? " — none left" : ""})`}
            </button>
          </div>
        </SwipeCard>
      ) : (
        <div style={S.card}>
          <p style={{ color: "#9aa3b2" }}>
            Deck empty. Run <code>npm run refresh-deck</code> to load blitz markets.
          </p>
        </div>
      )}

      {top ? (
        <p style={{ color: "#5a6478", fontSize: 12, textAlign: "center", marginTop: 4 }}>
          Swipe → {top.outcomeYesLabel} · ← {top.outcomeNoLabel} · ↑ skip
        </p>
      ) : null}
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
  yes: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "16px", fontSize: 16, fontWeight: 700, background: "#16a34a", color: "#fff", border: 0, borderRadius: 12, cursor: "pointer" },
  no: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "16px", fontSize: 16, fontWeight: 700, background: "#dc2626", color: "#fff", border: 0, borderRadius: 12, cursor: "pointer" },
  price: { fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  skip: { width: "100%", marginTop: 12, padding: "12px", fontSize: 14, fontWeight: 600, background: "transparent", color: "#d97706", border: "1px solid #d97706", borderRadius: 12, cursor: "pointer" },
};
