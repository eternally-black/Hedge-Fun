// COPIED from src/lib/time.ts — sync manually, do not diverge
// UTC-day helpers. The daily reset is 00:00 UTC (P-6, anti-timezone-abuse).
// A "day" is the 'YYYY-MM-DD' slice of the UTC ISO string — never a local date.

export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// 'YYYY-MM-DD' -> midnight-UTC Date.
export function dayToDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

// Whole UTC days between two day-keys: a - b. diffDays('2026-06-25','2026-06-24') === 1.
export function diffDays(a: string, b: string): number {
  const ms = dayToDate(a).getTime() - dayToDate(b).getTime();
  return Math.round(ms / 86_400_000);
}

// Day-of-week with Monday = 0 .. Sunday = 6 (the GM grid renders Mon→Sun).
// JS getUTCDay() is Sunday = 0, so we rotate.
export function weekdayMon0(key: string): number {
  return (dayToDate(key).getUTCDay() + 6) % 7;
}

// Start day-key of the user's CURRENT 7-day streak window. The window begins at streak
// level 1; position within it is (level-1) mod 7, so the start is that many days before
// the last qualified day. Level 0 (never/freshly started) → today. Used to draw the
// per-user week boundary on the GM grid.
export function streakWindowStartDay(level: number, lastQualifiedDay: string | null, today: string): string {
  if (level <= 0 || !lastQualifiedDay) return today;
  const posInWindow = (level - 1) % 7; // 0 = start day itself
  const start = new Date(dayToDate(lastQualifiedDay).getTime() - posInWindow * 86_400_000);
  return start.toISOString().slice(0, 10);
}
