// One-off backfill: replace the old CUID referralCodes with short codes (refcode.ts).
// Idempotent — only rewrites users whose current code isn't already a valid short code, so
// re-running is safe and a no-op once everyone's migrated. Run: npx tsx scripts/backfill-refcodes.ts
//
// Why needed: referralCode used to be @default(cuid()), leaking 25-char ids into invite links.
// New users get short codes at create time; existing rows need this sweep.
import { prisma } from "../src/lib/prisma";
import { newReferralCode, CODE_LEN, isReserved } from "../src/lib/refcode";

const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;

// A code is "already short" if it's exactly CODE_LEN chars, all from the alphabet, not reserved.
function isAlreadyShort(code: string): boolean {
  return code.length === CODE_LEN && ALPHABET.test(code) && !isReserved(code);
}

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, referralCode: true } });
  let migrated = 0;
  let skipped = 0;

  for (const u of users) {
    if (isAlreadyShort(u.referralCode)) { skipped++; continue; }
    // newReferralCode checks uniqueness against the live table, so it won't collide with codes
    // we've already assigned earlier in this same loop.
    const code = await newReferralCode();
    await prisma.user.update({ where: { id: u.id }, data: { referralCode: code } });
    migrated++;
    console.log(`  ${u.id.slice(0, 10)}… ${u.referralCode.slice(0, 12)}… -> ${code}`);
  }

  console.log(`\nbackfill done: ${migrated} migrated, ${skipped} already short (total ${users.length}).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
