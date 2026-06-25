// Reset the DEV_USER_EMAIL account's deck (wipe bets so all markets are swipeable again).
// Run: npm run dev:reset
import { prisma } from "../src/lib/prisma";
import { resetUserDeck } from "../src/lib/dev";
(async () => {
  const email = (process.env.DEV_USER_EMAIL ?? "").trim();
  if (!email) { console.error("DEV_USER_EMAIL not set"); process.exit(1); }
  const u = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
  if (!u) { console.error("dev user not found:", email); process.exit(1); }
  const r = await resetUserDeck(u.id);
  console.log(`reset ${email}: cleared ${r.bets} bets — deck re-deals on next /api/deck`);
  await prisma.$disconnect();
})();
