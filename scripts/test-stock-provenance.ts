import assert from "node:assert";
import { createHash, generateKeyPairSync } from "node:crypto";
import * as kit from "@solana/kit";
import {
  LIGHTHOUSE_PROGRAM,
  TxMismatchError,
  legacyUnsignedHashMatches,
  messageHashOf,
  sameMessageModuloGuards,
  transactionFeePayerOf,
  validateSignedTransaction,
} from "../src/lib/sponsor";

const keypair64 = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const secret = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const publicBytes = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return Uint8Array.from(Buffer.concat([secret.subarray(-32), publicBytes.subarray(-32)]));
};

async function main() {
const sponsor = await kit.createKeyPairSignerFromBytes(keypair64());
const user = await kit.createKeyPairSignerFromBytes(keypair64());
const blockhash = kit.getBase58Decoder().decode(new Uint8Array(32).fill(7)) as kit.Blockhash;
const memoProgram = kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const lighthouseProgram = kit.address(LIGHTHOUSE_PROGRAM);
const computeProgram = kit.address("ComputeBudget111111111111111111111111111111");
const guardTarget = kit.address("Ch4K4D2cTVNY7H7nJ2Y6byCiEeQzkE3AmGvJb1knYbTc");

const cu = (limit: number) => ({
  programAddress: computeProgram,
  accounts: [],
  data: new Uint8Array([2, limit & 255, (limit >>> 8) & 255, (limit >>> 16) & 255, (limit >>> 24) & 255]),
});
const cuPrice = (microLamports: bigint) => ({
  programAddress: computeProgram,
  accounts: [],
  data: new Uint8Array([3, ...Array.from({ length: 8 }, (_, i) => Number((microLamports >> BigInt(i * 8)) & 255n))]),
});
const memo = (data = 1) => ({
  programAddress: memoProgram,
  accounts: [
    { address: user.address, role: kit.AccountRole.READONLY_SIGNER },
    { address: guardTarget, role: kit.AccountRole.WRITABLE },
  ],
  data: new Uint8Array([data]),
});
const lighthouse = {
  programAddress: lighthouseProgram,
  // Observed Phantom shape: AssertTokenAccountMulti (10), silent log level, three assertions.
  // guardTarget is globally writable because the swap writes it, even though Lighthouse only reads.
  accounts: [{ address: guardTarget, role: kit.AccountRole.WRITABLE }],
  data: new Uint8Array([
    10, 0, 3,
    2, 6, 0, 0, 0, 0, 0, 0, 0, 4,
    1, ...new Uint8Array(32).fill(7), 0,
    6, 0, 0, 0, 0, 0, 0, 0, 0,
  ]),
};

function wire(feePayer: kit.Address, instructions: kit.Instruction[], hash = blockhash): Uint8Array {
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (value) => kit.setTransactionMessageFeePayer(feePayer, value),
    (value) =>
      kit.setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: hash, lastValidBlockHeight: 1_000n },
        value,
      ),
    (value) => kit.appendTransactionMessageInstructions(instructions, value),
  );
  return new Uint8Array(kit.getTransactionEncoder().encode(kit.compileTransaction(message)));
}

async function signedByUser(unsigned: Uint8Array): Promise<Uint8Array> {
  const tx = kit.getTransactionDecoder().decode(unsigned);
  const signed = await kit.partiallySignTransaction([user.keyPair], tx);
  return new Uint8Array(kit.getTransactionEncoder().encode(signed));
}

const original = wire(sponsor.address, [cu(72_261), cuPrice(1_000_000n), memo()]);
const exactSigned = await signedByUser(original);
assert.strictEqual(sameMessageModuloGuards(original, exactSigned, {}), true, "exact message is accepted");

const phantom = await signedByUser(wire(sponsor.address, [lighthouse, cu(75_613), cuPrice(1_000_000n), memo(), lighthouse]));
assert.strictEqual(sameMessageModuloGuards(original, phantom, {}), true, "Lighthouse guards + bounded CU raise are accepted");
assert.strictEqual(
  sameMessageModuloGuards(original, await signedByUser(wire(sponsor.address, [cu(172_262), cuPrice(1_000_000n), memo()])), {}),
  false,
  "CU raise above 100k is rejected",
);
assert.strictEqual(
  sameMessageModuloGuards(original, await signedByUser(wire(sponsor.address, [cu(172_261), cuPrice(1_000_000n), memo()])), {}),
  false,
  "a bounded CU raise that exceeds the sponsor's final priority-fee cap is rejected",
);
const memoryWrite = {
  programAddress: lighthouseProgram,
  accounts: [
    { address: lighthouseProgram, role: kit.AccountRole.READONLY },
    { address: kit.address("11111111111111111111111111111111"), role: kit.AccountRole.READONLY },
    { address: sponsor.address, role: kit.AccountRole.WRITABLE_SIGNER },
    { address: guardTarget, role: kit.AccountRole.WRITABLE },
    { address: user.address, role: kit.AccountRole.READONLY_SIGNER },
  ],
  data: new Uint8Array([0, 1, 2]),
};
assert.strictEqual(
  sameMessageModuloGuards(
    original,
    await signedByUser(wire(sponsor.address, [cu(72_261), cuPrice(1_000_000n), memo(), memoryWrite])),
    {},
  ),
  false,
  "Lighthouse MemoryWrite cannot make the sponsor fund a PDA",
);
assert.strictEqual(
  sameMessageModuloGuards(
    original,
    await signedByUser(
      wire(sponsor.address, [
        cu(72_261),
        cuPrice(1_000_000n),
        memo(),
        { ...lighthouse, accounts: [...lighthouse.accounts, { address: user.address, role: kit.AccountRole.READONLY_SIGNER }] },
      ]),
    ),
    {},
  ),
  false,
  "a Lighthouse assertion with extra accounts is rejected",
);
assert.strictEqual(
  sameMessageModuloGuards(original, await signedByUser(wire(sponsor.address, [cu(72_261), cuPrice(1_000_000n), memo(2)])), {}),
  false,
  "mutated swap instruction data is rejected",
);
assert.strictEqual(
  sameMessageModuloGuards(original, await signedByUser(wire(sponsor.address, [cu(72_261), cuPrice(1_000_000n), memo(), cu(1)])), {}),
  false,
  "an added non-Lighthouse instruction is rejected",
);
const otherHash = kit.getBase58Decoder().decode(new Uint8Array(32).fill(8)) as kit.Blockhash;
assert.strictEqual(
  sameMessageModuloGuards(original, await signedByUser(wire(sponsor.address, [cu(72_261), cuPrice(1_000_000n), memo()], otherHash)), {}),
  false,
  "a changed blockhash is rejected",
);

const originalB64 = Buffer.from(original).toString("base64");
const signedB64 = Buffer.from(exactSigned).toString("base64");
const checkedPartial = await validateSignedTransaction({
  signedTransactionB64: signedB64,
  builtTransactionB64: originalB64,
  expectedMessageHash: messageHashOf(original),
  expectedFeePayer: sponsor.address,
  allowMissingSignature: sponsor.address,
});
assert.strictEqual(checkedPartial.sig, null, "sponsored user-signed wire may leave only sponsor slot empty");
assert.strictEqual(transactionFeePayerOf(originalB64), sponsor.address);

const selfPaidUnsigned = wire(user.address, [cu(72_261), memo()]);
const selfPaidSigned = await signedByUser(selfPaidUnsigned);
const selfPaidB64 = Buffer.from(selfPaidSigned).toString("base64");
const checkedSelfPaid = await validateSignedTransaction({
  signedTransactionB64: selfPaidB64,
  builtTransactionB64: Buffer.from(selfPaidUnsigned).toString("base64"),
  expectedMessageHash: messageHashOf(selfPaidUnsigned),
  expectedFeePayer: user.address,
});
assert.ok(checkedSelfPaid.sig, "self-paid wire has a verified transaction signature");

const tampered = Uint8Array.from(selfPaidSigned);
tampered[10] ^= 1;
await assert.rejects(
  validateSignedTransaction({
    signedTransactionB64: Buffer.from(tampered).toString("base64"),
    builtTransactionB64: Buffer.from(selfPaidUnsigned).toString("base64"),
    expectedMessageHash: messageHashOf(selfPaidUnsigned),
    expectedFeePayer: user.address,
  }),
  TxMismatchError,
  "invalid Ed25519 signature is rejected",
);

const legacyHash = createHash("sha256").update(Buffer.from(selfPaidUnsigned).toString("base64")).digest("hex");
assert.strictEqual(legacyUnsignedHashMatches(selfPaidB64, legacyHash), true, "strict legacy unsigned envelope reconstructs");
assert.strictEqual(legacyUnsignedHashMatches(Buffer.from(phantom).toString("base64"), legacyHash), false, "rewritten legacy wire fails closed");

console.log("test-stock-provenance: OK");
}

main().catch((error) => {
  console.error("FAIL:", error);
  process.exitCode = 1;
});
