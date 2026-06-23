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
