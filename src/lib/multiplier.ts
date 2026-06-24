// ============================================================================
// THE x2 MULTIPLIER SEAM — the single place the trigger/cadence answer lands.
//
// The ledger stores RAW swipe points. The multiplier is applied at READ time only
// (in points.scorePoints, consumed by /me + the leaderboard query). Because history
// is raw, changing ACTIVE_MULTIPLIER below rescores EVERYONE retroactively, zero
// migration.
//
// x2 multiplies ONLY swipe points (P-7). Login + referral points are never multiplied.
//
// ANSWER (spec §8 Q1-2): trigger = 7-day streak; cadence = ONE-TIME per completed
// 7-day window. When the streak reaches level 7 (and 14, 21, ...), the swipe points
// earned across the just-completed 7-day window are doubled once, then it resets
// until the next completed window. NOT continuous.
// ============================================================================

// A one-time lump tied to a streak milestone does not fit a per-day boolean, so the
// strategy scores the WHOLE per-day swipe map against the streak in one call. ctx
// carries the ordered swipe-days + their raw points + the current streak level; the
// strategy decides how many of those days fall in completed windows and doubles them.
export interface MultiplierContext {
  userId: string;
  streakLevel: number;
  streakState: "ACTIVE" | "BURNED_RECOVERABLE" | "LOST";
  // Swipe-days of the CURRENT streak, ascending by utcDay, with that day's raw swipe
  // points. Derived in points.scorePoints from the ledger + streak level (no schema add).
  streakSwipeDays: { utcDay: string; raw: number }[];
}

export interface MultiplierStrategy {
  readonly id: string;
  // Returns the TOTAL multiplied swipe points (raw + any x2 bonus) for the streak.
  multipliedSwipePoints(ctx: MultiplierContext): number;
}

// --- Default: no multiplier. Sums raw, never doubles. ---
const Identity: MultiplierStrategy = {
  id: "identity",
  multipliedSwipePoints: (c) =>
    c.streakSwipeDays.reduce((sum, d) => sum + d.raw, 0),
};

// --- One-time 7-day-window x2 (the active model). -------------------------------
// completed windows = floor(level / 7). Double the swipe points of the EARLIEST
// windows*7 swipe-days of the current streak; the rest stay raw. Because the ledger
// is raw and we recompute at read time, each window's bonus is paid exactly once,
// is idempotent, doubles only that window's swipe points, and resets between windows.
export const SevenDayWindowOneTime: MultiplierStrategy = {
  id: "streak7_window_onetime",
  multipliedSwipePoints: (c) => {
    const doubledDays = Math.floor(c.streakLevel / 7) * 7;
    let total = 0;
    for (let i = 0; i < c.streakSwipeDays.length; i++) {
      const m = i < doubledDays ? 2 : 1;
      total += c.streakSwipeDays[i].raw * m;
    }
    return total;
  },
};

// >>> THE SINGLE LINE TO CHANGE WHEN THE ANSWER ARRIVES <<<
export const ACTIVE_MULTIPLIER: MultiplierStrategy = SevenDayWindowOneTime;
