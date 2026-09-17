// Self-checks for the Mobile Wallet Adapter link proof (DB-free). Run: npx tsx scripts/test-mwa-link.ts
// A real Ed25519 key signs a real SIWS message; then every field that MUST fail is broken in turn.
import assert from "node:assert";
import { webcrypto } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { checkMwaNonce, MWA_NONCE_TTL_MS, mwaNonce, parseSiws, SIWS_STATEMENT, verifySiwsLink } from "../src/lib/mwa-link";

async function main() {
  const KEY = "test-hmac-key";
  const USER = "user_abc";
  const NOW = 1_800_000_000_000;
  const DOMAIN = "app.hedgeyour.fun";

  // ---- nonce: alphanumeric, ≥ 8 chars (SIWS), bound to user, expires ----
  const nonce = mwaNonce(USER, NOW, KEY);
  assert.match(nonce, /^[a-z0-9]{42}$/, "nonce is 42 alphanumeric chars");
  assert.strictEqual(checkMwaNonce(nonce, USER, NOW + 1000, KEY), "ok");
  assert.strictEqual(checkMwaNonce(nonce, "someone_else", NOW + 1000, KEY), "bad", "bound to the user");
  assert.strictEqual(checkMwaNonce(nonce, USER, NOW + 1000, "other-key"), "bad", "bound to the secret");
  assert.strictEqual(checkMwaNonce(nonce, USER, NOW + MWA_NONCE_TTL_MS + 1, KEY), "expired");
  assert.strictEqual(checkMwaNonce(nonce.slice(0, 41) + "x", USER, NOW, KEY), "bad", "tampered mac");
  assert.strictEqual(checkMwaNonce(mwaNonce(USER, NOW + 120_000, KEY), USER, NOW, KEY), "bad", "from the future");

  // ---- a wallet's SIWS: sign the message with a real Ed25519 key ----
  const kp = (await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  assert.strictEqual(pubRaw.length, 32);
  const address = getAddressDecoder().decode(pubRaw);
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

  function siws(o: { domain?: string; address?: string; nonce?: string | null } = {}): string {
    const lines = [
      `${o.domain ?? DOMAIN} wants you to sign in with your Solana account:`,
      o.address ?? address,
      "",
      SIWS_STATEMENT,
      "",
      `URI: https://${DOMAIN}`,
      "Version: 1",
      "Chain ID: mainnet",
    ];
    if (o.nonce !== null) lines.push(`Nonce: ${o.nonce ?? nonce}`);
    lines.push(`Issued At: ${new Date(NOW).toISOString()}`);
    return lines.join("\n");
  }
  async function sign(text: string, key: CryptoKey = kp.privateKey) {
    const msg = new TextEncoder().encode(text);
    const sig = new Uint8Array(await webcrypto.subtle.sign("Ed25519", key, msg));
    return { signedMessageB64: b64(msg), signatureB64: b64(sig) };
  }
  const base = { addressB64: b64(pubRaw), userId: USER, expectedDomain: DOMAIN, now: NOW + 5000, key: KEY };

  // parse
  const parsed = parseSiws(siws());
  assert.deepStrictEqual(parsed, { domain: DOMAIN, address, nonce });
  assert.strictEqual(parseSiws("hello"), null);

  // happy path
  const ok = await verifySiwsLink({ ...base, ...(await sign(siws())) });
  assert.deepStrictEqual(ok, { ok: true, address }, "valid SIWS links the signing address");

  // domain not enforced in dev
  const dev = await verifySiwsLink({ ...base, expectedDomain: null, ...(await sign(siws({ domain: "localhost:3000" }))) });
  assert.strictEqual(dev.ok, true);

  // ---- every way it must fail ----
  const fail = async (label: string, input: Parameters<typeof verifySiwsLink>[0], error: string) => {
    const r = await verifySiwsLink(input);
    assert.strictEqual(r.ok, false, label);
    assert.strictEqual((r as { error: string }).error, error, label);
  };
  await fail("other site", { ...base, ...(await sign(siws({ domain: "evil.example" }))) }, "domain_mismatch");
  await fail("message names another account", { ...base, ...(await sign(siws({ address: "11111111111111111111111111111111" }))) }, "address_mismatch");
  await fail("no nonce", { ...base, ...(await sign(siws({ nonce: null }))) }, "bad_nonce");
  await fail("someone else's nonce", { ...base, ...(await sign(siws({ nonce: mwaNonce("intruder", NOW, KEY) }))) }, "bad_nonce");
  await fail("stale nonce", { ...base, now: NOW + MWA_NONCE_TTL_MS + 1, ...(await sign(siws())) }, "nonce_expired");
  {
    // signature by a different key over the same message → the address line still matches, the sig does not
    const other = (await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    await fail("wrong key", { ...base, ...(await sign(siws(), other.privateKey)) }, "bad_signature");
  }
  {
    // message tampered after signing
    const s = await sign(siws());
    const tampered = Buffer.from(siws() + " ").toString("base64");
    await fail("tampered message", { ...base, ...s, signedMessageB64: tampered }, "bad_signature");
  }
  await fail("garbage encoding", { ...base, addressB64: "AAAA", signedMessageB64: "AAAA", signatureB64: "AAAA" }, "bad_encoding");
  await fail("not a SIWS message", { ...base, ...(await sign("please sign this")) }, "bad_message");

  console.log("mwa-link self-checks passed ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
