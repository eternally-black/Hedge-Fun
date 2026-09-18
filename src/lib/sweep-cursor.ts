import type { PrismaClient } from "@prisma/client";

export type SweepCursorValue = { createdAt: Date; id: string };

export async function readSweepCursor(prisma: PrismaClient, name: string): Promise<SweepCursorValue | null> {
  const cursor = await prisma.sweepCursor.findUnique({ where: { name } });
  if (!cursor?.afterCreatedAt || !cursor.afterId) return null;
  return { createdAt: cursor.afterCreatedAt, id: cursor.afterId };
}

export async function writeSweepCursor(
  prisma: PrismaClient,
  name: string,
  value: SweepCursorValue | null,
): Promise<void> {
  await prisma.sweepCursor.upsert({
    where: { name },
    create: { name, afterCreatedAt: value?.createdAt ?? null, afterId: value?.id ?? null },
    update: { afterCreatedAt: value?.createdAt ?? null, afterId: value?.id ?? null },
  });
}
