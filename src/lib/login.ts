import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay } from "./time";
import { writePoints } from "./points";
import { LOGIN_BONUS } from "./config";

// Daily "GM" login mark. Idempotent per UTC day: the LoginMark unique [userId,utcDay]
// is the gate, so a second tap the same day awards nothing. The GM tap also qualifies
// the streak day (qualifyDay) — login and "opening the app" are one action in the MVP.
export async function recordLogin(
  userId: string,
  at?: Date,
): Promise<{ awarded: boolean; amount: number; utcDay: string }> {
  const day = utcDay(at);

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.loginMark.create({
        data: { userId, utcDay: day, bonusAmount: LOGIN_BONUS },
      });
      await tx.dailyCounter.upsert({
        where: { userId_utcDay: { userId, utcDay: day } },
        create: { userId, utcDay: day, loginMarked: true },
        update: { loginMarked: true },
      });
      await writePoints(tx, {
        userId,
        type: "LOGIN",
        amount: LOGIN_BONUS,
        utcDay: day,
      });
      return { awarded: true, amount: LOGIN_BONUS, utcDay: day };
    });
  } catch (e) {
    // P2002 = already marked today. Idempotent no-op.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { awarded: false, amount: 0, utcDay: day };
    }
    throw e;
  }
}
