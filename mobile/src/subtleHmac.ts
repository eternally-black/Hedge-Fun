// crypto.subtle for Hermes, reduced to the one thing the Polymarket SDK uses: HMAC-SHA256 over its
// L2 request headers (importKey "raw" + sign). Hermes has getRandomValues (react-native-get-random-values)
// but no SubtleCrypto, and every authenticated CLOB call — the geo verdict, the order post — goes
// through it. Proven on the emulator 2026-09-29: cred derivation + an L2 read succeeded under this
// shim. Anything else asked of it throws rather than quietly returning a wrong digest.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";

type Bytes = ArrayBuffer | ArrayBufferView;
const toBytes = (x: Bytes): Uint8Array =>
  x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
const algName = (a: unknown) => (typeof a === "string" ? a : (a as { name?: string })?.name);
const hashName = (a: unknown) => {
  const h = (a as { hash?: unknown })?.hash;
  return typeof h === "string" ? h : (h as { name?: string })?.name;
};

const g = globalThis as unknown as { crypto?: { subtle?: unknown } };
g.crypto ??= {};
if (!g.crypto.subtle) {
  g.crypto.subtle = {
    importKey: async (format: string, keyData: Bytes, algorithm: unknown) => {
      if (format !== "raw" || algName(algorithm) !== "HMAC" || hashName(algorithm) !== "SHA-256") {
        throw new Error("subtle shim: only raw HMAC SHA-256 keys");
      }
      return { type: "secret", algorithm: { name: "HMAC", hash: { name: "SHA-256" } }, raw: toBytes(keyData).slice() };
    },
    sign: async (algorithm: unknown, key: { raw?: Uint8Array }, data: Bytes) => {
      if (algName(algorithm) !== "HMAC" || !key?.raw) throw new Error("subtle shim: only HMAC sign");
      const out = hmac(sha256, key.raw, toBytes(data));
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },
  };
}
