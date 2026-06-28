// Tiny in-process fixed-window rate limiter. No npm dep, no Redis — a single Map of
// per-key windows. Used to bound unauthenticated/abuse-prone endpoints (e.g. /api/ref-click)
// before they touch the DB.
//
// ponytail: PER-PROCESS only. The counters live in this process's memory, so they reset on
// restart and DON'T coordinate across instances. That's fine today (single prod container — see
// MEMORY: HedgeFun deploy). If this ever runs multi-instance, swap the Map for Redis (INCR + EXPIRE).

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

// Returns true if the call is ALLOWED, false if the key has exhausted `limit` hits in the
// current `windowMs`. Fixed-window: the first hit of a window starts the clock; the window
// rolls over (counter resets) once `now >= resetAt`.
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}
