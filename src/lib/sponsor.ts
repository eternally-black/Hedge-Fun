// Fee sponsorship for REAL tokenized-stock trades: WE are the fee payer, the user only signs. A
// first-time buyer holds USDC and no SOL — without this they cannot transact at all, and telling a
// new user to "go buy some SOL for gas" is where the funnel ends. So the server builds the swap
// itself (Jupiter gives us the instructions, not a finished tx), puts the sponsor in the fee-payer
// slot, takes over the ATA-creation rent, and co-signs ONLY a message whose sha256 equals the one it
// built (coSign). That hash equality is the entire authorisation model: the sponsor signature
// can never land on bytes the server did not compose, whatever the client sends back.
//
// The secret lives in STOCK_SPONSOR_SECRET (base58 64-byte ed25519 secret key — Phantom's "export
// private key" format). Absent or malformed => sponsorship is simply OFF and the self-paid path
// still works. The secret is never logged, never returned, never put in an error message.
//
// Verified facts (@solana/kit 5.5.1, verified live 2026-09-15 — .scratch/kit-probe.ts):
//  - compileTransaction() on a message whose fee payer was set by ADDRESS (not a signer) works and
//    yields signatures = { [feePayer]: null, [otherSigner]: null } in fee-payer-first order.
//  - getTransactionEncoder().encode(tx) -> wire bytes with empty (all-zero) signature slots;
//    getTransactionDecoder().decode(bytes) round-trips messageBytes byte-for-byte, so the sha256 of
//    messageBytes is stable across client signing (a signature never changes the message).
//  - partiallySignTransaction([keyPair], tx) fills one slot and leaves the others null.
//  - compressTransactionMessageUsingAddressLookupTables(msg, { [lut]: Address[] }) needs the table
//    CONTENTS, and kit 5.5.1 exports no fetcher for them — hence decodeLookupTable + getAccountInfo.
// Verified facts (Solana on-chain layouts, unchanged since the ALT program shipped):
//  - AddressLookupTable account: 56-byte header (u32 type, u64 deactivationSlot, u64
//    lastExtendedSlot, u8 lastExtendedSlotStartIndex, 1+32 optional authority, u16 padding) then a
//    packed array of 32-byte addresses.
//  - SPL-Token / Token-2022 CloseAccount: data = [9], accounts = [account(w), destination(w),
//    owner(signer)] — confirmed live in Jupiter's own cleanupInstruction (see jupiter-swap.ts).

import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { decodeBase58 } from "./stocks";
import { swapInstructions, type JupIx } from "./jupiter-swap";
import { getAccountInfoBase64, getLatestBlockhash, getTokenAccounts, HeliusUnavailableError } from "./helius";
import { STOCK_SPONSOR_MAX_PRIORITY_LAMPORTS } from "./config";

// The Associated Token program: its instructions fund a new token account out of accounts[0], which
// is the ONE account we rewrite so the rent comes from the sponsor.
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// ─── typed errors (mapped to statuses by the routes) ────────────────────────────────────────────────

// No usable sponsor key. The buy path falls back to self-paid; the sell path has no fallback -> 409.
export class SponsorUnavailableError extends Error {
  constructor() {
    super("sponsor_unavailable");
    this.name = "SponsorUnavailableError";
  }
}
// The client sent back something other than the message we built (or did not sign it). -> 409.
export class TxMismatchError extends Error {
  constructor() {
    super("tx_mismatch");
    this.name = "TxMismatchError";
  }
}

// ─── the key ────────────────────────────────────────────────────────────────────────────────────────

// Parsed once per DISTINCT env value: cheap on the hot path, and a test that sets or clears
// STOCK_SPONSOR_SECRET between cases does not need a reset hook.
let cache: { env: string; bytes: Uint8Array | null; signer: Promise<KeyPairSigner> | null } | null = null;

function parsed(): { bytes: Uint8Array | null; signer: Promise<KeyPairSigner> | null } {
  const env = (process.env.STOCK_SPONSOR_SECRET ?? "").trim();
  if (cache?.env === env) return cache;
  let bytes: Uint8Array | null = null;
  if (env) {
    const decoded = decodeBase58(env);
    // 64 bytes = 32-byte seed + 32-byte public key. Anything else is not a Solana secret key; say so
    // once, WITHOUT echoing any part of the value.
    if (decoded && decoded.length === 64) bytes = decoded;
    else console.warn("sponsor: STOCK_SPONSOR_SECRET is not a base58 64-byte key — sponsorship disabled");
  }
  cache = { env, bytes, signer: bytes ? createKeyPairSignerFromBytes(bytes) : null };
  return cache;
}

export function sponsorConfigured(): boolean {
  return parsed().bytes !== null;
}

// The sponsor's address = the last 32 bytes of the secret key (no crypto needed, no await).
export function sponsorAddress(): string | null {
  const b = parsed().bytes;
  return b ? getBase58Decoder().decode(b.subarray(32)) : null;
}

async function sponsorSigner(): Promise<KeyPairSigner> {
  const s = parsed().signer;
  if (!s) throw new SponsorUnavailableError();
  return s;
}

// ─── pure helpers ───────────────────────────────────────────────────────────────────────────────────

// Rewrite the funding payer of every Associated-Token-program instruction to the sponsor. Everything
// else (including the roles) is left exactly as Jupiter built it — the sponsor is a signer of this
// transaction anyway, so an isSigner:true funding slot stays valid.
export function patchAtaPayer(ixs: JupIx[], sponsor: string): JupIx[] {
  return ixs.map((ix) =>
    ix.programId === ATA_PROGRAM && ix.accounts.length > 0
      ? { ...ix, accounts: ix.accounts.map((a, i) => (i === 0 ? { ...a, pubkey: sponsor } : a)) }
      : ix,
  );
}

// Jupiter's cleanup instruction closes the wrapped-SOL account a multi-hop route needed, and hands its
// rent to the USER — because Jupiter assumes the user funded it. When WE funded it (the account did
// not exist before this transaction, so the patched setup instruction paid its rent), the refund
// belongs to the sponsor. CloseAccount is [account(w), destination(w), owner(signer)] with data [9]
// in both token programs; anything else is passed through untouched. An account the user already
// owned is never touched: closing it to the sponsor would take THEIR rent. (Seen live 2026-09-16:
// a QQQx→SOL→USDT→USDC sell refunded 1,488,440 lamports of sponsor rent to the user.)
export function patchCleanupDestination(ix: JupIx | null, sponsorFundedAccounts: ReadonlySet<string>, sponsor: string): JupIx | null {
  if (!ix || ix.accounts.length < 3) return ix;
  const data = Buffer.from(ix.data, "base64");
  const isClose = data.length === 1 && data[0] === 9;
  if (!isClose || !sponsorFundedAccounts.has(ix.accounts[0].pubkey)) return ix;
  return { ...ix, accounts: ix.accounts.map((a, i) => (i === 1 ? { ...a, pubkey: sponsor } : a)) };
}

// The token accounts the setup instructions will CREATE for the user in this transaction (the ATA
// program's create-idempotent: [payer, ata, owner, mint, ...]). One balance read per setup mint —
// an account that already exists costs the sponsor nothing and must keep its rent with the user.
// The mint travels with the account because the caller RECORDS this provenance (SponsorFundedAccount):
// a later sell has only (payer, mint) to find the row by.
async function sponsorFundedAtas(setup: JupIx[], owner: string): Promise<{ account: string; mint: string }[]> {
  const out: { account: string; mint: string }[] = [];
  for (const ix of setup) {
    if (ix.programId !== ATA_PROGRAM || ix.accounts.length < 4) continue;
    const account = ix.accounts[1].pubkey;
    const mint = ix.accounts[3].pubkey;
    if ((await getTokenAccounts(owner, mint)).length === 0) out.push({ account, mint });
  }
  return out;
}

// The addresses stored in an on-chain Address Lookup Table account (56-byte header, then 32 bytes
// each). A truncated tail is ignored rather than guessed.
export function decodeLookupTable(data: Uint8Array): string[] {
  const HEADER = 56;
  if (data.length <= HEADER) return [];
  const b58 = getBase58Decoder();
  const out: string[] = [];
  for (let off = HEADER; off + 32 <= data.length; off += 32) out.push(b58.decode(data.subarray(off, off + 32)));
  return out;
}

// sha256 of the MESSAGE inside a wire transaction. Signatures are not part of it, so this is the one
// value that is identical before and after any wallet signs.
export function messageHashOf(wireTxBytes: Uint8Array): string {
  const tx = getTransactionDecoder().decode(wireTxBytes);
  return createHash("sha256").update(Buffer.from(tx.messageBytes)).digest("hex");
}

export function transactionFeePayerOf(base64: string): string {
  try {
    const wire = new Uint8Array(Buffer.from(base64, "base64"));
    const tx = getTransactionDecoder().decode(wire);
    return getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts[0];
  } catch {
    throw new TxMismatchError();
  }
}

export function transactionSignatureOf(base64: string): string {
  try {
    return getSignatureFromTransaction(getTransactionDecoder().decode(new Uint8Array(Buffer.from(base64, "base64"))));
  } catch {
    throw new TxMismatchError();
  }
}

// Pre-audit self-paid attempts stored sha256(base64(unsigned-wire)) and omitted the wire itself.
// A landed transaction can reconstruct that exact unsigned envelope only when the wallet changed no
// message bytes. This is a narrow compatibility proof; failure stays PENDING for manual review.
export function legacyUnsignedHashMatches(signedBase64: string, expectedHash: string): boolean {
  try {
    const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(signedBase64, "base64")));
    const signatures = Object.fromEntries(Object.keys(tx.signatures).map((signer) => [signer, null]));
    const unsigned = { ...tx, signatures } as typeof tx;
    const wire = new Uint8Array(getTransactionEncoder().encode(unsigned));
    const base64 = Buffer.from(wire).toString("base64");
    return createHash("sha256").update(base64).digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const CU_LIMIT_RAISE_MAX = 100_000;

type AnyIx = {
  programAddress: Address;
  accounts?: readonly { address: Address; role: AccountRole }[];
  data?: ReadonlyUint8Array;
};

function cuLimitOf(ix: AnyIx): number | null {
  const d = ix.data;
  if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM || !d || d.length !== 5 || d[0] !== 2) return null;
  return (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0;
}

function raisedCuLimit(ours: AnyIx, theirs: AnyIx): boolean {
  const before = cuLimitOf(ours);
  const after = cuLimitOf(theirs);
  return before !== null && after !== null && after >= before && after - before <= CU_LIMIT_RAISE_MAX;
}

function u64Le(bytes: ReadonlyUint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
  return value;
}

function priorityFeeWithinCap(instructions: readonly AnyIx[]): boolean {
  let limit: number | null = null;
  let priceMicroLamports: bigint | null = null;
  for (const instruction of instructions) {
    if (instruction.programAddress !== COMPUTE_BUDGET_PROGRAM || !instruction.data) continue;
    const data = instruction.data;
    if (data[0] === 2) {
      if (data.length !== 5 || limit !== null) return false;
      limit = cuLimitOf(instruction);
    } else if (data[0] === 3) {
      if (data.length !== 9 || priceMicroLamports !== null) return false;
      priceMicroLamports = u64Le(data, 1);
    }
  }
  if (priceMicroLamports === null || priceMicroLamports === 0n) return true;
  // No explicit limit means the runtime can assign up to its per-transaction maximum. Use that
  // ceiling instead of understating the sponsor's possible fee.
  const chargedUnits = BigInt(limit ?? 1_400_000);
  const lamports = (chargedUnits * priceMicroLamports + 999_999n) / 1_000_000n;
  return lamports <= BigInt(STOCK_SPONSOR_MAX_PRIORITY_LAMPORTS);
}

function compiledAccountRoles(
  message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>,
  lookup: Record<Address, Address[]>,
): Map<string, AccountRole> {
  const roles = new Map<string, AccountRole>();
  const signerCount = message.header.numSignerAccounts;
  const writableSignerCount = signerCount - message.header.numReadonlySignerAccounts;
  const writableUnsignedEnd = message.staticAccounts.length - message.header.numReadonlyNonSignerAccounts;
  message.staticAccounts.forEach((account, index) => {
    const role =
      index < signerCount
        ? index < writableSignerCount
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : index < writableUnsignedEnd
          ? AccountRole.WRITABLE
          : AccountRole.READONLY;
    roles.set(account, role);
  });
  if ("addressTableLookups" in message) {
    for (const table of message.addressTableLookups ?? []) {
      const addresses = lookup[table.lookupTableAddress];
      if (!addresses) continue;
      for (const index of table.writableIndexes) {
        const account = addresses[index];
        if (account) roles.set(account, AccountRole.WRITABLE);
      }
      for (const index of table.readonlyIndexes) {
        const account = addresses[index];
        if (account) roles.set(account, AccountRole.READONLY);
      }
    }
  }
  return roles;
}

const LIGHTHOUSE_ACCOUNT_COUNTS = new Map<number, number>([
  [2, 1],
  [3, 1],
  [4, 2],
  [5, 1],
  [6, 1],
  [7, 1],
  [8, 1],
  [9, 1],
  [10, 1],
  [11, 1],
  [12, 1],
  [13, 1],
  [14, 1],
  [15, 0],
  [16, 3],
  [17, 1],
]);

function validLighthouseAssertion(instruction: AnyIx, builtRoles: ReadonlyMap<string, AccountRole>): boolean {
  const data = instruction.data;
  if (!data || data.length < 3) return false;
  const requiredAccounts = LIGHTHOUSE_ACCOUNT_COUNTS.get(data[0]);
  // Discriminators 0/1 are MemoryWrite/MemoryClose: they can spend sponsor lamports on a PDA and
  // are never a wallet assertion. Every supported assertion begins with a bounded LogLevel enum.
  if (requiredAccounts === undefined || data[1] > 6) return false;
  const accounts = instruction.accounts ?? [];
  if (accounts.length !== requiredAccounts) return false;
  for (const account of accounts) {
    const builtRole = builtRoles.get(account.address);
    if (builtRole !== undefined) {
      // Compiled roles are global. A legitimate assertion over the swap's writable ATA therefore
      // decompiles as writable too; require the original global role rather than false-rejecting it.
      if (account.role !== builtRole) return false;
    } else if (account.role !== AccountRole.READONLY) {
      // A guard may introduce a new read-only observation account, never a signer/writable account.
      return false;
    }
  }
  return true;
}

async function lookupTablesFor(wires: Uint8Array[]): Promise<Record<Address, Address[]>> {
  const decoder = getCompiledTransactionMessageDecoder();
  const tableIds = new Set<string>();
  for (const wire of wires) {
    try {
      const message = decoder.decode(getTransactionDecoder().decode(wire).messageBytes);
      if ("addressTableLookups" in message) {
        for (const table of message.addressTableLookups ?? []) tableIds.add(table.lookupTableAddress);
      }
    } catch {
      throw new TxMismatchError();
    }
  }
  const lookup: Record<Address, Address[]> = {};
  for (const tableId of tableIds) {
    const account = await getAccountInfoBase64(tableId);
    if (!account) throw new HeliusUnavailableError(`lookup table ${tableId} not found`);
    lookup[address(tableId)] = decodeLookupTable(account.data).map((value) => address(value));
  }
  return lookup;
}

// Phantom may add only Lighthouse assertions and a bounded SetComputeUnitLimit increase. The
// original fee payer, blockhash, signer set, and every original instruction (program/accounts/
// roles/data/order) must survive exactly. Address-table index reordering is harmless after decompile.
export function sameMessageModuloGuards(
  builtWire: Uint8Array,
  signedWire: Uint8Array,
  lookup: Record<Address, Address[]>,
): boolean {
  const decoder = getCompiledTransactionMessageDecoder();
  let built: ReturnType<typeof decoder.decode>;
  let signed: ReturnType<typeof decoder.decode>;
  try {
    built = decoder.decode(getTransactionDecoder().decode(builtWire).messageBytes);
    signed = decoder.decode(getTransactionDecoder().decode(signedWire).messageBytes);
  } catch {
    return false;
  }
  if (built.lifetimeToken !== signed.lifetimeToken) return false;
  if (built.header.numSignerAccounts !== signed.header.numSignerAccounts) return false;
  if (built.header.numReadonlySignerAccounts !== signed.header.numReadonlySignerAccounts) return false;
  if (built.staticAccounts[0] !== signed.staticAccounts[0]) return false;
  const builtSigners = [...built.staticAccounts.slice(0, built.header.numSignerAccounts)].sort().join(",");
  const signedSigners = [...signed.staticAccounts.slice(0, signed.header.numSignerAccounts)].sort().join(",");
  if (builtSigners !== signedSigners) return false;

  let builtMessage: ReturnType<typeof decompileTransactionMessage>;
  let signedMessage: ReturnType<typeof decompileTransactionMessage>;
  try {
    builtMessage = decompileTransactionMessage(built, { addressesByLookupTableAddress: lookup });
    signedMessage = decompileTransactionMessage(signed, { addressesByLookupTableAddress: lookup });
  } catch {
    return false;
  }
  const key = (ix: AnyIx) =>
    [
      ix.programAddress,
      ...(ix.accounts ?? []).map((account) => `${account.address}:${account.role}`),
      Buffer.from(ix.data ?? new Uint8Array()).toString("base64"),
    ].join("|");
  const originals = builtMessage.instructions as unknown as readonly AnyIx[];
  const originalKeys = originals.map(key);
  const builtRoles = compiledAccountRoles(built, lookup);
  const signedInstructions = signedMessage.instructions as unknown as readonly AnyIx[];
  if (!priorityFeeWithinCap(signedInstructions)) return false;
  let originalIndex = 0;
  for (const instruction of signedInstructions) {
    if (
      originalIndex < originals.length &&
      (key(instruction) === originalKeys[originalIndex] || raisedCuLimit(originals[originalIndex], instruction))
    ) {
      originalIndex++;
      continue;
    }
    if (instruction.programAddress !== LIGHTHOUSE_PROGRAM) return false;
    if (!validLighthouseAssertion(instruction, builtRoles)) return false;
  }
  return originalIndex === originals.length;
}

function hasValidSignature(addressString: string, message: ReadonlyUint8Array, signature: Uint8Array | null): boolean {
  if (!signature || signature.length !== 64) return false;
  const raw = decodeBase58(addressString);
  if (!raw || raw.length !== 32) return false;
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]);
    return verifyEd25519(
      null,
      Buffer.from(Uint8Array.from(message)),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      signature,
    );
  } catch {
    return false;
  }
}

export async function validateSignedTransaction(p: {
  signedTransactionB64: string;
  builtTransactionB64: string;
  expectedMessageHash: string;
  expectedFeePayer: string;
  allowMissingSignature?: string;
}): Promise<{ wire: string; sig: string | null }> {
  const signedWire = new Uint8Array(Buffer.from(p.signedTransactionB64, "base64"));
  const builtWire = new Uint8Array(Buffer.from(p.builtTransactionB64, "base64"));
  let tx: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    tx = getTransactionDecoder().decode(signedWire);
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    throw new TxMismatchError();
  }
  if (message.staticAccounts[0] !== p.expectedFeePayer) throw new TxMismatchError();
  const hash = createHash("sha256").update(Buffer.from(tx.messageBytes)).digest("hex");
  if (hash !== p.expectedMessageHash) {
    const lookup = await lookupTablesFor([builtWire, signedWire]);
    if (!sameMessageModuloGuards(builtWire, signedWire, lookup)) throw new TxMismatchError();
  }
  const signatures = tx.signatures as Record<string, Uint8Array | null>;
  for (const signer of message.staticAccounts.slice(0, message.header.numSignerAccounts)) {
    if (signer === p.allowMissingSignature && signatures[signer] === null) continue;
    if (!hasValidSignature(signer, tx.messageBytes, signatures[signer] ?? null)) throw new TxMismatchError();
  }
  let sig: string | null = null;
  try {
    sig = getSignatureFromTransaction(tx);
  } catch {
    if (p.allowMissingSignature !== p.expectedFeePayer) throw new TxMismatchError();
  }
  return { wire: Buffer.from(signedWire).toString("base64"), sig };
}

function toKitIx(ix: JupIx): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({
      address: address(a.pubkey),
      role: a.isSigner
        ? a.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : a.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: new Uint8Array(Buffer.from(ix.data, "base64")),
  };
}

// ─── build ──────────────────────────────────────────────────────────────────────────────────────────

// Assemble ONE unsigned v0 transaction: compute budget, setup (rent on us), the swap, any extra
// instruction the caller needs inside the same atomic tx (the SELL close-account), cleanup, other.
// Returns the wire tx for the wallet to sign, the hash that authorises our co-signature, and the
// accounts whose rent this transaction puts on the sponsor (the caller records that provenance —
// only the account itself knows who fronted it, never the lot that happens to land in it).
export async function buildSponsoredSwapTx(p: {
  quoteResponse: unknown;
  userPublicKey: string;
  extraInstructions?: JupIx[];
  // External wallets front their own token-account rent because wallet scanners reject cleanup
  // that returns their lamports to a different address. Embedded wallets use the sponsor.
  sponsorRent?: boolean;
}): Promise<{
  swapTransaction: string;
  messageHash: string;
  lastValidBlockHeight: number;
  fundedAccounts: { account: string; mint: string }[];
}> {
  const sponsor = sponsorAddress();
  if (!sponsor) throw new SponsorUnavailableError();

  const ix = await swapInstructions({
    quoteResponse: p.quoteResponse,
    userPublicKey: p.userPublicKey,
    maxPriorityLamports: STOCK_SPONSOR_MAX_PRIORITY_LAMPORTS,
  });

  const sponsorRent = p.sponsorRent !== false;
  const funded = sponsorRent ? await sponsorFundedAtas(ix.setupInstructions, p.userPublicKey) : [];
  const cleanup = sponsorRent
    ? patchCleanupDestination(ix.cleanupInstruction, new Set(funded.map((f) => f.account)), sponsor)
    : ix.cleanupInstruction;
  const ordered: JupIx[] = [
    ...ix.computeBudgetInstructions,
    ...(sponsorRent ? patchAtaPayer(ix.setupInstructions, sponsor) : ix.setupInstructions),
    ix.swapInstruction,
    ...(p.extraInstructions ?? []),
    ...(cleanup ? [cleanup] : []),
    ...ix.otherInstructions,
  ];

  // The lookup tables must be resolved before compression: kit needs the CONTENTS, not the address.
  const [{ blockhash, lastValidBlockHeight }, tables] = await Promise.all([
    getLatestBlockhash(),
    Promise.all(
      ix.addressLookupTableAddresses.map(async (lut) => {
        const acc = await getAccountInfoBase64(lut);
        // Jupiter routed through this table one second ago; if we cannot read it, the RPC is the
        // problem. Compiling without it would silently blow the 1232-byte packet instead.
        if (!acc) throw new HeliusUnavailableError(`lookup table ${lut} not found`);
        return [lut, decodeLookupTable(acc.data)] as const;
      }),
    ),
  ]);

  const lookup: Record<string, Address[]> = {};
  for (const [lut, addrs] of tables) lookup[lut] = addrs.map((a) => address(a));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(sponsor), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ordered.map(toKitIx), m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, lookup),
  );

  const tx = compileTransaction(message);
  const wire = new Uint8Array(getTransactionEncoder().encode(tx));
  return {
    swapTransaction: Buffer.from(wire).toString("base64"),
    // Hash the ENCODED-then-decoded message, so what we store is exactly what a client will hash.
    messageHash: messageHashOf(wire),
    lastValidBlockHeight,
    fundedAccounts: funded,
  };
}

// ─── co-sign ────────────────────────────────────────────────────────────────────────────────────────

// Add the sponsor's signature to a user-signed transaction and hand back BOTH the wire bytes and the
// signature the transaction will have once it is sent. The signature is known before the send (the
// fee payer's signature IS the transaction signature), and the caller stamps it on the attempt
// FIRST: a send that times out after the broadcast would otherwise leave an attempt with no
// signature, a swap on chain, and a client free to retry it into a second purchase.
// The ONLY thing that authorises the signature is expectedMessageHash: the server co-signs nothing
// it did not build.
export async function coSign(p: {
  signedTransactionB64: string;
  expectedMessageHash: string;
  userAddress: string;
  builtTransactionB64: string;
}): Promise<{ wire: string; sig: string }> {
  const signer = await sponsorSigner();

  const checked = await validateSignedTransaction({
    signedTransactionB64: p.signedTransactionB64,
    builtTransactionB64: p.builtTransactionB64,
    expectedMessageHash: p.expectedMessageHash,
    expectedFeePayer: signer.address,
    allowMissingSignature: signer.address,
  });
  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(checked.wire, "base64")));

  const signed = await partiallySignTransaction([signer.keyPair], tx);
  return { wire: getBase64EncodedWireTransaction(signed), sig: getSignatureFromTransaction(signed) };
}

// ─── close-account instruction (SELL) ───────────────────────────────────────────────────────────────

// Close the user's emptied xStock account in the same transaction as the sell, with the rent going
// BACK to the sponsor that fronted it. Hand-built rather than pulled from a token client library:
// CloseAccount is one opcode with three accounts and is byte-identical in Token and Token-2022.
export function closeAccountIx(p: {
  tokenProgram: string;
  account: string;
  destination: string;
  owner: string;
}): JupIx {
  return {
    programId: p.tokenProgram,
    accounts: [
      { pubkey: p.account, isSigner: false, isWritable: true },
      { pubkey: p.destination, isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]).toString("base64"),
  };
}
