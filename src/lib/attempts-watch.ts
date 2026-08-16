// Stuck-attempt watcher (S8): OrderAttempts sitting in SUBMITTING/POSTED are ambiguous submissions
// (plan §2.1 biggest-risk rule: never re-sign) — a human or Gate-0 reconciliation resolves them,
// but ops must HEAR about it. Poller-safe: zero SDK deps.
import type { PrismaClient } from "@prisma/client";
import { sendOpsTelegram } from "./glitchtip";

let lastAlertAt = 0;
const ALERT_THROTTLE_MS = 3_600_000; // 1 hour

export async function watchStuckAttempts(prisma: PrismaClient, now = new Date()): Promise<{ stuck: number }> {
  const cutoff = new Date(now.getTime() - 15 * 60_000);
  const stuck = await prisma.orderAttempt.findMany({
    where: {
      state: { in: ["SUBMITTING", "POSTED"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, userId: true, state: true, updatedAt: true },
  });

  if (stuck.length > 0 && Date.now() - lastAlertAt > ALERT_THROTTLE_MS) {
    lastAlertAt = Date.now();
    void sendOpsTelegram(
      `[real] ${stuck.length} order attempt(s) stuck in SUBMITTING/POSTED >15m — needs reconciliation`,
    );
  }
  return { stuck: stuck.length };
}

export function _resetAlertThrottleForTests(): void {
  lastAlertAt = 0;
}
