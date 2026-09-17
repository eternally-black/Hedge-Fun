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

import { createHash } from "node:crypto";
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

// Phantom's Lighthouse program — the ONE program a wallet may add to a message we built.
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

// The contents of every address table these messages load from — what decompiling them needs.
async function lookupTablesFor(wires: Uint8Array[]): Promise<Record<Address, Address[]>> {
  const dec = getCompiledTransactionMessageDecoder();
  const luts = new Set<string>();
  for (const w of wires) {
    let m: ReturnType<typeof dec.decode>;
    try {
      m = dec.decode(getTransactionDecoder().decode(w).messageBytes);
    } catch {
      continue;
    }
    if ("addressTableLookups" in m) for (const l of m.addressTableLookups ?? []) luts.add(l.lookupTableAddress);
  }
  const out: Record<Address, Address[]> = {};
  for (const lut of luts) {
    const acc = await getAccountInfoBase64(lut);
    if (!acc) throw new HeliusUnavailableError(`lookup table ${lut} not found`);
    out[address(lut)] = decodeLookupTable(acc.data).map((a) => address(a));
  }
  return out;
}

// Is `signedWire` OUR message plus nothing but Lighthouse guards? An external wallet (Phantom)
// rewrites an unsigned transaction on its way to the user: it appends assertions that make the
// transaction fail if the outcome is not what the user saw in the simulation. Assertions cannot
// move funds. So a message that is exactly ours — same fee payer, same signers, same blockhash,
// every one of our instructions in order with the same program, accounts, roles and data — with
// Lighthouse instructions added anywhere is still a message we built, and the sponsor may sign it.
// Anything else (one more instruction of any other program, one byte of ours changed, one of ours
// missing, ours reordered, an account demoted, a table we cannot read) is not. Pure given the table
// contents; `lookup` must hold every table either message loads from.
export function sameMessageModuloGuards(builtWire: Uint8Array, signedWire: Uint8Array, lookup: Record<Address, Address[]>): boolean {
  const dec = getCompiledTransactionMessageDecoder();
  let a: ReturnType<typeof dec.decode>, b: ReturnType<typeof dec.decode>;
  try {
    a = dec.decode(getTransactionDecoder().decode(builtWire).messageBytes);
    b = dec.decode(getTransactionDecoder().decode(signedWire).messageBytes);
  } catch {
    return false;
  }
  if (a.lifetimeToken !== b.lifetimeToken) return false;
  if (a.header.numSignerAccounts !== b.header.numSignerAccounts) return false;
  if (a.header.numReadonlySignerAccounts !== b.header.numReadonlySignerAccounts) return false;
  if (a.staticAccounts[0] !== b.staticAccounts[0]) return false; // the fee payer
  const signersA = [...a.staticAccounts.slice(0, a.header.numSignerAccounts)].sort().join(",");
  const signersB = [...b.staticAccounts.slice(0, b.header.numSignerAccounts)].sort().join(",");
  if (signersA !== signersB) return false;

  let ma: ReturnType<typeof decompileTransactionMessage>, mb: ReturnType<typeof decompileTransactionMessage>;
  try {
    ma = decompileTransactionMessage(a, { addressesByLookupTableAddress: lookup });
    mb = decompileTransactionMessage(b, { addressesByLookupTableAddress: lookup });
  } catch {
    return false;
  }
  // The decompiled instruction, whatever the message version: program, accounts with roles, data.
  type AnyIx = { programAddress: Address; accounts?: readonly { address: Address; role: AccountRole }[]; data?: ReadonlyUint8Array };
  const key = (ix: AnyIx) =>
    [ix.programAddress, ...(ix.accounts ?? []).map((acc) => `${acc.address}:${acc.role}`), Buffer.from(ix.data ?? new Uint8Array()).toString("base64")].join("|");
  const ours = (ma.instructions as unknown as readonly AnyIx[]).map(key);
  let i = 0;
  for (const ix of mb.instructions as unknown as readonly AnyIx[]) {
    if (i < ours.length && key(ix) === ours[i]) {
      i++;
      continue;
    }
    if (ix.programAddress !== LIGHTHOUSE_PROGRAM) return false;
  }
  return i === ours.length;
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

  const funded = await sponsorFundedAtas(ix.setupInstructions, p.userPublicKey);
  const cleanup = patchCleanupDestination(ix.cleanupInstruction, new Set(funded.map((f) => f.account)), sponsor);
  const ordered: JupIx[] = [
    ...ix.computeBudgetInstructions,
    ...patchAtaPayer(ix.setupInstructions, sponsor),
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
  // The bytes the attempt was built from. With them, a message that does not hash to the expected
  // value is still accepted when it is ours plus nothing but Lighthouse guards (sameMessageModuloGuards).
  builtTransactionB64?: string;
}): Promise<{ wire: string; sig: string }> {
  const signer = await sponsorSigner();

  const signedWire = new Uint8Array(Buffer.from(p.signedTransactionB64, "base64"));
  let tx: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    tx = getTransactionDecoder().decode(signedWire);
  } catch {
    throw new TxMismatchError(); // not even a transaction
  }

  const hash = createHash("sha256").update(Buffer.from(tx.messageBytes)).digest("hex");
  if (hash !== p.expectedMessageHash) {
    if (!p.builtTransactionB64) throw new TxMismatchError();
    const builtWire = new Uint8Array(Buffer.from(p.builtTransactionB64, "base64"));
    const lookup = await lookupTablesFor([builtWire, signedWire]);
    if (!sameMessageModuloGuards(builtWire, signedWire, lookup)) throw new TxMismatchError();
  }

  // The user must actually have signed. Their slot exists because they are a signer of the swap.
  const userSig = (tx.signatures as Record<string, Uint8Array | null>)[p.userAddress];
  if (!userSig || userSig.length !== 64) throw new TxMismatchError();

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
