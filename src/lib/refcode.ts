import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

// Short, shareable referral codes — e.g. /r/XGVR. Replaces the old @default(cuid()), which
// leaked the raw 25-char Prisma id into invite links. Adapted from CallShot's genCode.

// 31-char alphabet: no look-alikes (no I/O/0/1/l) and no _-/ so a code is URL-clean and
// unambiguous read aloud. 4 chars -> 31^4 ≈ 923k combos. Plenty early; the DB-collision retry
// in newReferralCode keeps it correct as the space fills.
// ponytail: 4 chars per the product call. If collisions ever get frequent (retry loop logging
// a warning), bump CODE_LEN to 5 (31^5 ≈ 28.6M) — one-char change, no schema/route impact.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 31 chars
export const CODE_LEN = 4;

// Slugs a code must never equal, or /r/<code> / the root would shadow a real path. Compared
// case-insensitively (codes are uppercase; routes are lowercase) to be safe.
const RESERVED = new Set(["api", "r", "next", "well", "favi"]);

// One random candidate. Uniform over ALPHABET via rejection-free modulo: 256 % 31 != 0 so there's
// a tiny bias toward the first (256 mod 31 = 8) symbols — negligible for a non-crypto-secret share
// code, and the DB uniqueness check is what actually guarantees correctness.
export function randomCode(len = CODE_LEN): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export function isReserved(code: string): boolean {
  return RESERVED.has(code.toLowerCase());
}

// A fresh code guaranteed unique against existing users (and not a reserved slug). Retries on
// the rare collision; throws if it somehow can't find a free one (signals the space is full ->
// time to bump CODE_LEN). Pass a tx client during a transaction, else uses the default client.
export async function newReferralCode(
  db: Prisma.TransactionClient | typeof prisma = prisma,
  attempts = 12,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const code = randomCode();
    if (isReserved(code)) continue;
    const taken = await db.user.findUnique({ where: { referralCode: code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new Error(`newReferralCode: no free ${CODE_LEN}-char code after ${attempts} tries — bump CODE_LEN`);
}
