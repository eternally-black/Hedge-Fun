// ============================================================================
// THE x2 MULTIPLIER SEAM — the single place the OPEN trigger/cadence lands.
//
// The ledger stores RAW swipe points. The multiplier is applied at READ time only
// (in points.effectivePoints + the leaderboard query). Because history is raw,
// changing ACTIVE_MULTIPLIER below rescores EVERYONE retroactively, zero migration.
//
// x2 multiplies ONLY swipe points (P-7). Login + referral points are never multiplied.
//
// OPEN (spec §8 Q1-2): trigger = 7-day streak vs 70 cumulative swipe points vs both;
//                      cadence = one-time per window vs continuous while streak alive.
// When the answer arrives: pick/author the strategy and set ACTIVE_MULTIPLIER. One line.
// ============================================================================

export interface MultiplierContext {
  userId: string;
  utcDay: string; // the day whose swipe points we're scoring
  streakLevel: number;
  streakState: "ACTIVE" | "BURNED_RECOVERABLE" | "LOST";
  cumulativeSwipePoints: number; // raw, lifetime — for the 70-point trigger
  swipePointsOnDay: number; // raw swipe points earned that day
}

export interface MultiplierStrategy {
  readonly id: string;
  // Returns the multiplier for that day's SWIPE points. 1 = identity, 2 = x2.
  multiplierForDay(ctx: MultiplierContext): number;
}

// --- Default: no multiplier. Ships at launch (x2 trigger/cadence still OPEN). ---
const Identity: MultiplierStrategy = {
  id: "identity",
  multiplierForDay: () => 1,
};

// --- Swappable concretes — drop ACTIVE_MULTIPLIER onto one when the answer lands. ---

// Trigger: 7-day streak. Cadence: continuous while the streak is active & >=7.
export const SevenDayContinuous: MultiplierStrategy = {
  id: "streak7_continuous",
  multiplierForDay: (c) =>
    c.streakState === "ACTIVE" && c.streakLevel >= 7 ? 2 : 1,
};

// Trigger: 70 cumulative swipe points. Cadence: continuous once crossed.
export const SeventyPointsContinuous: MultiplierStrategy = {
  id: "points70_continuous",
  multiplierForDay: (c) => (c.cumulativeSwipePoints >= 70 ? 2 : 1),
};

// >>> THE SINGLE LINE TO CHANGE WHEN THE ANSWER ARRIVES <<<
export const ACTIVE_MULTIPLIER: MultiplierStrategy = Identity;
