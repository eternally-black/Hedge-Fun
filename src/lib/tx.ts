import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

// Run a transaction at Serializable isolation, retrying on a write-conflict/deadlock (P2034).
// Use ONLY for transactions whose body is idempotent on retry — delta-only high-water marks
// (referral accrual), conditional/re-read-then-write updates (top-up free flag / artifact spend).
// A blind retry of a non-idempotent body would double-apply, so don't wrap raw increments.
export async function runSerializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  maxRetries = 4,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (e) {
      // P2034 = transaction write conflict / deadlock / serialization failure → safe to retry.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034" && attempt < maxRetries) continue;
      throw e;
    }
  }
}
