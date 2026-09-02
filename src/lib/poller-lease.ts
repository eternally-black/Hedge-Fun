// Single-runner lease for the poller tick. Why a lease row and not pg advisory locks:
// Prisma's pool gives every query a different session, so a session lock cannot be held
// across a tick. A row with an expiry is the honest primitive: the holder renews it each
// tick, and a crashed holder frees it by itself when expiresAt passes.
import type { PrismaClient } from "@prisma/client";

export async function acquirePollerLease(
  prisma: PrismaClient,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  // updateMany is atomic: the WHERE matches only if we already hold it OR it has expired,
  // so two runners racing for an expired lease cannot both win (one updateMany wins).
  const updated = await prisma.pollerLease.updateMany({
    where: { id: 1, OR: [{ holder }, { expiresAt: { lt: new Date() } }] },
    data: { holder, expiresAt },
  });
  if (updated.count === 1) return true;

  // Row does not exist yet — first ever acquire. create can race with another runner's
  // create; a unique violation on id 1 means they won, so we return false.
  try {
    await prisma.pollerLease.create({ data: { id: 1, holder, expiresAt } });
    return true;
  } catch {
    return false;
  }
}
