// Encrypted-at-rest storage for derived L2 CLOB API creds (owner decision Q4, plan §2.2).
// These are NOT signing keys — read/cancel auth only — so D5 stays intact; still: AES-256-GCM,
// key from env (REAL_CREDS_KEY, 64 hex chars = 32 bytes), OUTSIDE database backups by
// construction. Missing env or row → null, callers presence-gate (503), never throw at boot.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type ClobCreds = { key: string; secret: string; passphrase: string };

function encKey(): Buffer | null {
  const hex = process.env.REAL_CREDS_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

export async function saveClobCreds(prisma: PrismaClient, userId: string, creds: ClobCreds): Promise<boolean> {
  const key = encKey();
  if (!key) return false;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(userId, "utf8")); // bind ciphertext to the user — a row swap must not decrypt
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final(), cipher.getAuthTag()]);
  await prisma.clobCredential.upsert({
    where: { userId },
    create: { userId, ciphertext, nonce, keyVersion: 1 },
    update: { ciphertext, nonce, keyVersion: 1, revokedAt: null },
  });
  return true;
}

export async function loadClobCreds(prisma: PrismaClient, userId: string): Promise<ClobCreds | null> {
  const key = encKey();
  if (!key) return null;
  const row = await prisma.clobCredential.findUnique({ where: { userId } });
  if (!row || row.revokedAt) return null;
  try {
    const buf = Buffer.from(row.ciphertext);
    const tag = buf.subarray(buf.length - 16);
    const body = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.nonce));
    decipher.setAAD(Buffer.from(userId, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as ClobCreds;
  } catch {
    return null; // wrong key version / tampered row — treat as absent, re-derivation path handles it
  }
}
