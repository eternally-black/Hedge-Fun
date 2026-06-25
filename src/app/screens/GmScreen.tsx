"use client";

import { type Me } from "../ui";

// Daily GM check-in (ported from app design). One tap = streak day + login bonus (1 pt, P-2) +
// the GM marks today. The grid is a fixed Mon→Sun calendar week (consistent for everyone); a
// vertical cutoff marks where THIS user's personal 7-day streak window begins, and the live
// day-of-week (not streak%7) drives "today".
const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const;
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

type DayCell = {
  label: string;
  isToday: boolean;
  isDone: boolean;
  /** true on the column that starts this user's 7-day window — render the cutoff before it. */
  isWindowStart: boolean;
};

// Pure: build the 7 Mon→Sun cells from the user's streak state. Kept module-level so it
// isn't re-created each render and can be unit-tested (scripts/test-gm-week.ts).
export function buildGmWeek(
  todayWeekday: number,
  windowStartWeekday: number,
  streakLevel: number,
  checkedInToday: boolean,
): DayCell[] {
  // Days already completed in the current window (before today), from the personal start.
  const doneBeforeToday = streakLevel > 0 ? (streakLevel - (checkedInToday ? 1 : 0)) % 7 : 0;
  return DAY_LABELS.map((label, col) => {
    // Position of this column within the user's window: 0 at windowStart, wrapping Mon→Sun.
    const posInWindow = (col - windowStartWeekday + 7) % 7;
    const isToday = col === todayWeekday;
    const isDone = posInWindow < doneBeforeToday || (checkedInToday && isToday);
    return { label, isToday, isDone, isWindowStart: col === windowStartWeekday };
  });
}

export function GmScreen({ me, busy, onGM }: { me: Me | null; busy: boolean; onGM: () => void }) {
  const done = me?.loginMarkedToday ?? false;
  const streak = me?.streak.level ?? 0;
  const todayWeekday = me?.streak.todayWeekday ?? 0;
  const windowStartWeekday = me?.streak.windowStartWeekday ?? 0;
  const week = buildGmWeek(todayWeekday, windowStartWeekday, streak, done);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", background: "radial-gradient(120% 70% at 50% 30%, color-mix(in srgb,var(--energy) 22%,transparent), transparent 60%)" }}>
      <div style={{ fontSize: 64, animation: "hfFlame 1.6s ease-in-out infinite" }}>🔥</div>
      <div style={{ fontFamily: "var(--df)", fontSize: 50, lineHeight: 0.95, marginTop: 10 }}>GM, DEGEN</div>
      <div style={{ fontSize: 14, color: "var(--muted)", maxWidth: 260, marginTop: 8, textWrap: "pretty" }}>
        {done ? "You're checked in. Streak is safe — come back tomorrow." : "Check in to keep your streak burning."}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 24 }}>
        {week.map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
            {/* cutoff: a clear vertical divider before this user's window-start column */}
            {d.isWindowStart && i > 0 && (
              <div aria-hidden style={{ width: 2, alignSelf: "stretch", borderRadius: 2, background: "var(--energy)", opacity: 0.7, marginRight: 0 }} />
            )}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
              <div style={{ width: 30, height: 30, borderRadius: 10, background: d.isDone ? "color-mix(in srgb,var(--gold) 22%,transparent)" : "var(--panel)", border: `1.5px solid ${d.isToday ? "var(--energy)" : d.isDone ? "var(--gold)" : "var(--line)"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: d.isDone ? "var(--gold)" : "var(--muted)" }}>
                {d.isDone ? "🔥" : d.isToday && !done ? "☀" : ""}
              </div>
              <div style={{ fontSize: 8, color: d.isWindowStart ? "var(--energy)" : "var(--muted)", fontWeight: d.isWindowStart ? 700 : 400 }}>{d.label}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 8, opacity: 0.8 }}>
        Your week starts {DAY_NAMES[windowStartWeekday]}
      </div>

      <div style={{ marginTop: 22, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 16, padding: "14px 22px", display: "flex", gap: 22 }}>
        <div><div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 22, color: "var(--energy)" }}>+1</div><div style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>Point</div></div>
        <div style={{ width: 1, background: "var(--line)" }} />
        <div><div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 22, color: "var(--gold)" }}>🔥 {streak}</div><div style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>Streak</div></div>
      </div>

      <div
        onClick={done || busy ? undefined : onGM}
        style={{ marginTop: 26, width: "100%", maxWidth: 300, background: done ? "var(--panel)" : "linear-gradient(135deg,var(--energy),color-mix(in srgb,var(--energy) 55%,#000))", color: done ? "var(--muted)" : "#fff", fontFamily: "var(--df)", fontSize: 22, padding: 16, borderRadius: 18, cursor: done || busy ? "default" : "pointer", boxShadow: done ? "none" : "0 14px 30px -8px color-mix(in srgb,var(--energy) 60%,transparent)", border: done ? "1px solid var(--line)" : "none" }}
      >
        {done ? "✓ Checked in — see you tomorrow" : "☀ Claim & keep streak"}
      </div>
    </div>
  );
}
