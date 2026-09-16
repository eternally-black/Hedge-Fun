// The REAL tokenized-stock buy path: build a Jupiter swap for a VERIFIED wallet, record the attempt
// the server itself built, then book the lot ONLY from what the chain shows — and only if the landed
// tx matches the attempt (payer, mint, ExactIn amount, minimum output). The server never trusts a
// client-sent amount, price, mint or receipt. The chain is the receipt; the attempt row is what the
// receipt is checked against.
//
// Lifecycle: buildAttempt (PENDING) -> client signs + sends -> markSent (stamps sig) -> confirmAttempt
// (reads the landed tx, matches, books the lot). The poller sweeps PENDING rows: with a sig it
// re-confirms; without one and past lastValidBlockHeight it searches the payer's recent signatures
// for a match, else EXPIRES. reconcileRealLots closes lots the wallet no longer backs.
//
// With a sponsor key configured (sponsor.ts) the same lifecycle gains ONE different step: the server
// builds the tx with itself as fee payer, the wallet SIGNS ONLY, and submitSigned co-signs + sends
// (so the user needs no SOL at all). SELL is the mirror image of BUY on the same attempt row — it is
// always sponsored, because the whole point is a wallet that holds only xStocks and USDC.

import { createHash } from "node:crypto";
import { isAddress } from "@solana/kit";
import type { Prisma, StockBuyAttempt } from "@prisma/client";
import { prisma } from "./prisma";
import { captureToGlitchTip } from "./glitchtip";
import {
  USDC_MINT,
  parseSwapDelta,
  parseSellDelta,
  attemptMatches,
  sellMatches,
  usdcMicroToCents,
  usdcMicroToCentsFloor,
  entryPriceCents,
  sigBytesValid,
  signedBy,
  type RpcParsedTx,
} from "./stocks";
import { quoteSwap, buildSwapTx, type JupIx } from "./jupiter-swap";
import {
  getTransaction,
  getSignaturesForAddress,
  getBlockHeight,
  getTokenBalanceRaw,
  getTokenAccounts,
  getAccountInfoBase64,
  sendRawTransaction,
} from "./helius";
import {
  sponsorConfigured,
  sponsorAddress,
  buildSponsoredSwapTx,
  coSign,
  closeAccountIx,
  SponsorUnavailableError,
} from "./sponsor";
import { verifiedWallets, hasStockConsent, StockUnavailableError } from "./stocks-db";
import {
  STOCK_SWAP_SLIPPAGE_BPS,
  STOCK_MAX_PRICE_IMPACT_BP,
  STOCK_CONFIRM_POLLS,
  STOCK_ATTEMPT_SWEEP_AFTER_MS,
  STOCK_TERMS_VERSION,
  STOCK_SPONSOR_MAX_PER_USER_PER_DAY,
  STOCK_MIN_STAKE_CENTS,
} from "./config";
import type { StockRealTxResponse, StockRealSellTxResponse, StockRealConfirmResponse } from "./api-types";

// ─── typed errors (mapped to statuses by the routes) ────────────────────────────────────────────────

export class StockConsentRequiredError extends Error {
  constructor() {
    super("stock_consent_required");
    this.name = "StockConsentRequiredError";
  }
}
export class WalletNotVerifiedError extends Error {
  constructor() {
    super("wallet_not_verified");
    this.name = "WalletNotVerifiedError";
  }
}
export class AttemptNotFoundError extends Error {
  constructor() {
    super("attempt_not_found");
    this.name = "AttemptNotFoundError";
  }
}
export class TxNotFoundError extends Error {
  constructor() {
    super("tx_not_found");
    this.name = "TxNotFoundError";
  }
}
// message IS the code: tx_failed | not_this_buy | attempt_expired | attempt_failed | attempt_not_pending
export class TxRejectedError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "TxRejectedError";
  }
}
// This user has spent their share of the sponsor's SOL for today. -> 429.
export class SponsorLimitError extends Error {
  constructor() {
    super("sponsor_limit");
    this.name = "SponsorLimitError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── consent ────────────────────────────────────────────────────────────────────────────────────────

export async function recordStockConsent(userId: string, version: number): Promise<void> {
  if (version !== STOCK_TERMS_VERSION) throw new RangeError("bad_version");
  await prisma.user.update({
    where: { id: userId },
    data: { stockConsentAt: new Date(), stockConsentVersion: version },
  });
}

// ─── build ──────────────────────────────────────────────────────────────────────────────────────────

// The sponsor pays real SOL for every tx it fronts, so one user cannot drain it: a rolling 24 h
// count of their sponsored attempts (built, not landed — a signature we never see still cost us a
// blockhash and a build) is the whole quota.
//
// Counting and inserting must be ONE decision, or two builds that both read 19/20 both pass. The
// per-user advisory lock serialises a single user's concurrent builds and is released when the
// transaction ends; two DIFFERENT users never wait on each other. Every attempt row — BUY, SELL,
// sponsored or not — is created here so the quota can never be bypassed by a new call site.
//
// `reserve` runs INSIDE that same transaction, under the same lock, before the count: the caller's
// reserve-or-reuse decision. A row it returns is re-served and nothing is created — which is how
// "one live SELL per lot" survives two concurrent builds (each of which sees no pending sell of its
// own accord, and would otherwise both insert one).
async function createAttempt(
  data: Prisma.StockBuyAttemptUncheckedCreateInput,
  reserve?: (tx: Prisma.TransactionClient) => Promise<StockBuyAttempt | null>,
): Promise<{ attempt: StockBuyAttempt; reserved: boolean }> {
  return prisma.$transaction(async (tx) => {
    if (data.sponsored || reserve) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.userId}))`;
    }
    if (reserve) {
      const existing = await reserve(tx);
      if (existing) return { attempt: existing, reserved: true };
    }
    if (data.sponsored) {
      const used = await tx.stockBuyAttempt.count({
        where: { userId: data.userId, sponsored: true, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
      });
      if (used >= STOCK_SPONSOR_MAX_PER_USER_PER_DAY) throw new SponsorLimitError();
    }
    return { attempt: await tx.stockBuyAttempt.create({ data }), reserved: false };
  });
}

// One row per token account this sponsored build puts the sponsor's rent behind (F4: rent belongs to
// the ACCOUNT, not to the lot that lands in it). Written at BUILD time — the only moment we know the
// account did not exist — and retired again if the attempt never lands.
async function recordSponsorFunding(
  attempt: { id: string; userId: string; payer: string },
  funded: { account: string; mint: string }[],
): Promise<void> {
  for (const f of funded) {
    await prisma.sponsorFundedAccount.upsert({
      where: { account: f.account },
      create: { account: f.account, userId: attempt.userId, payer: attempt.payer, mint: f.mint, attemptId: attempt.id },
      // A row can only be here for an account the chain no longer has (it was closed, or its funding
      // attempt is still pending): this build is opening it again, so the provenance starts over.
      update: {
        userId: attempt.userId,
        payer: attempt.payer,
        mint: f.mint,
        attemptId: attempt.id,
        fundedAt: new Date(),
        confirmedAt: null,
        closedAt: null,
      },
    });
  }
}

// An attempt that died (EXPIRED/FAILED) never created its accounts: no swap, no rent, no row.
async function dropUnconfirmedFunding(attemptId: string, db: Prisma.TransactionClient = prisma): Promise<void> {
  await db.sponsorFundedAccount.deleteMany({ where: { attemptId, confirmedAt: null } });
}

export async function buildAttempt(
  user: { id: string; stockConsentVersion: number | null },
  p: { assetId?: string; symbol?: string; stakeCents: number; payer: string; hedgeSuggestionId?: string },
): Promise<StockRealTxResponse> {
  if (!hasStockConsent(user)) throw new StockConsentRequiredError();
  if (!isAddress(p.payer)) throw new WalletNotVerifiedError();
  const wallets = await verifiedWallets(user.id);
  if (!wallets.includes(p.payer)) throw new WalletNotVerifiedError();

  // A deck card names the asset by id; a hedge card only knows the symbol.
  const asset = p.assetId
    ? await prisma.stockAsset.findUnique({ where: { id: p.assetId } })
    : p.symbol
      ? await prisma.stockAsset.findUnique({ where: { symbol: p.symbol } })
      : null;
  if (!asset) throw new StockUnavailableError("asset_not_found");
  if (asset.halted) throw new StockUnavailableError("asset_halted");

  // A hedge suggestion is accepted into AT MOST one lot (the unique spans PAPER and REAL). Finding
  // that out at confirm time would mean a swap that landed on chain and a lot that cannot be
  // created — so refuse before anything is built.
  if (p.hedgeSuggestionId) {
    const accepted = await prisma.stockPosition.findFirst({
      where: { userId: user.id, hedgeSuggestionId: p.hedgeSuggestionId },
      select: { id: true },
    });
    if (accepted) throw new StockUnavailableError("hedge_already_accepted");
  }

  // A sponsored buy we already SENT (the signature is stamped before the send) may be landing right
  // now. Building a second one for the same asset is how a user buys twice off one tap — wait for
  // the first to resolve (confirm, or the sweep past its block height).
  const inFlight = await prisma.stockBuyAttempt.findFirst({
    where: { userId: user.id, assetId: asset.id, kind: "BUY", status: "PENDING", sponsored: true, sig: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (inFlight && (await getBlockHeight()) <= Number(inFlight.lastValidBlockHeight)) {
    throw new StockUnavailableError("buy_in_flight");
  }

  // Size the buy to what the wallet actually holds: a chip larger than the USDC balance would become
  // a swap that fails at simulation (and, sponsored, a fee paid for nothing). Below the minimum stake
  // there is nothing sensible to buy. The response quote carries the amount really used.
  const usdcMicro = await getTokenBalanceRaw(p.payer, USDC_MINT);
  const affordableCents = Number(usdcMicro / 10_000n);
  let stakeCents = p.stakeCents;
  if (affordableCents < stakeCents) {
    if (affordableCents < STOCK_MIN_STAKE_CENTS) throw new StockUnavailableError("insufficient_usdc");
    stakeCents = affordableCents;
  }

  const quote = await quoteSwap({
    inputMint: USDC_MINT,
    outputMint: asset.mint,
    amount: BigInt(stakeCents) * 10_000n,
    slippageBps: STOCK_SWAP_SLIPPAGE_BPS,
  });
  if (quote.priceImpactBp > STOCK_MAX_PRICE_IMPACT_BP) throw new StockUnavailableError("price_impact");

  // Sponsored when we hold a key: the tx is OURS (fee payer + ATA rent) and the wallet only signs.
  // Without a key the old self-paid path is unchanged, so the app still works with no sponsor at all.
  const sponsored = sponsorConfigured();
  // WHO pays the token account's rent, recorded at the only moment we can know it: the setup
  // instruction creates the account (on us) only when the wallet holds none for this mint. A wallet
  // that already has one — or that pays for its own — keeps that rent when the lot is sold.
  const rentFromSponsor = sponsored && (await getTokenAccounts(p.payer, asset.mint)).length === 0;
  // Self-paid: the client sends back the very bytes we handed it, so hashing the base64 is enough.
  // Sponsored: the hash is over the compiled MESSAGE, because signing changes the bytes (the
  // signature slots) but never the message.
  const tx = sponsored
    ? await buildSponsoredSwapTx({ quoteResponse: quote.raw, userPublicKey: p.payer })
    : await buildSwapTx(quote.raw, p.payer).then((t) => ({
        ...t,
        messageHash: createHash("sha256").update(t.swapTransaction).digest("hex"),
        fundedAccounts: [] as { account: string; mint: string }[], // self-paid: the wallet fronts its own rent
      }));

  const { attempt } = await createAttempt({
    userId: user.id,
    assetId: asset.id,
    payer: p.payer,
    kind: "BUY",
    sponsored,
    rentFromSponsor,
    stakeCents,
    inAmountMicro: quote.inAmount,
    minOutBase: quote.minOutBase,
    msgHash: tx.messageHash,
    lastValidBlockHeight: BigInt(tx.lastValidBlockHeight),
    hedgeSuggestionId: p.hedgeSuggestionId ?? null,
  });
  await recordSponsorFunding(attempt, tx.fundedAccounts);

  return {
    attemptId: attempt.id,
    swapTransaction: tx.swapTransaction,
    lastValidBlockHeight: tx.lastValidBlockHeight,
    payer: p.payer,
    feePayer: sponsored ? sponsorAddress() : null,
    quote: {
      inAmountMicro: String(quote.inAmount),
      outAmountBase: String(quote.outAmount),
      minOutBase: String(quote.minOutBase),
      priceImpactBp: quote.priceImpactBp,
    },
  };
}

// ─── build (SELL) ───────────────────────────────────────────────────────────────────────────────────

// The newest PENDING sell of one lot — bytes or not. The reserve-or-expire decision reads it twice:
// once cheaply (before a quote is spent) and once under the per-user lock, which is the one that counts.
function pendingSell(db: Prisma.TransactionClient, userId: string, positionId: string) {
  return db.stockBuyAttempt.findFirst({
    where: { userId, positionId, kind: "SELL", status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
}

// Re-serving an attempt hands back exactly what the user already signed for: the amount in and the
// MINIMUM out. The mid quote is not persisted, so the minimum stands in for it — a retry never
// advertises more than the first build already guaranteed.
function reservedSell(a: StockBuyAttempt, payer: string): StockRealSellTxResponse {
  return {
    attemptId: a.id,
    swapTransaction: a.unsignedTx!,
    lastValidBlockHeight: Number(a.lastValidBlockHeight),
    payer,
    feePayer: sponsorAddress()!,
    quote: {
      inAmountBase: String(a.inAmountMicro),
      outAmountMicro: String(a.minOutBase),
      minOutMicro: String(a.minOutBase),
      priceImpactBp: 0,
    },
  };
}

// Sell ONE open REAL lot in full: ExactIn the lot's own qtyBase, xStock -> USDC, fee-sponsored. There
// is no self-paid fallback — a wallet that bought through the sponsor has no SOL to pay with, so no
// key means no sell here (the user can always sell in their own wallet; reconcileRealLots then
// closes the lot as "wallet").
export async function buildSellAttempt(
  user: { id: string; stockConsentVersion: number | null },
  positionId: string,
): Promise<StockRealSellTxResponse> {
  if (!hasStockConsent(user)) throw new StockConsentRequiredError();

  const lot = await prisma.stockPosition.findFirst({
    where: { id: positionId, userId: user.id, mode: "REAL" },
    include: { asset: true },
  });
  if (!lot) throw new StockUnavailableError("position_not_found");
  if (lot.closedAt) throw new StockUnavailableError("lot_closed");

  // The lot's own payer signs the sale — it holds the tokens. It must STILL be a verified wallet.
  const payer = lot.payer;
  if (!payer || !isAddress(payer)) throw new WalletNotVerifiedError();
  const wallets = await verifiedWallets(user.id);
  if (!wallets.includes(payer)) throw new WalletNotVerifiedError();

  if (!sponsorConfigured()) throw new SponsorUnavailableError();

  // A stamped pending sell may have LANDED with its confirm interrupted. Expiring it on block
  // height alone books a SECOND sale of a lot that is already sold (and the first one then answers
  // attempt_expired for a sale that took the user's tokens), so ask the chain first — one poll, no
  // sleep. Outside the lock: this is RPC, and a receipt that matches closes the lot right here.
  const stamped = await prisma.stockBuyAttempt.findFirst({
    where: { userId: user.id, positionId: lot.id, kind: "SELL", status: "PENDING", sig: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  // One height read for both the pre-check and the locked decision below (it only moves forward, and
  // an RPC call inside the transaction would hold this user's lock over the network).
  const height = await getBlockHeight();
  let terminalId: string | null = null; // a pending sell the locked step must retire
  if (stamped?.sig) {
    let landed = false;
    try {
      await confirmAttempt(user.id, stamped.id, stamped.sig, { polls: 1, sleepMs: 0 });
      landed = true;
    } catch (e) {
      if (e instanceof TxNotFoundError) {
        // Not on chain. Past its block height it never will be -> retire it; otherwise it may still
        // land, and re-serving keeps the user on the ONE transaction that can.
        if (height > Number(stamped.lastValidBlockHeight)) terminalId = stamped.id;
      } else if (e instanceof TxRejectedError) {
        // tx_failed (confirmSell already marked it FAILED) or not_this_buy: the signature is spent
        // either way, so this attempt can never settle the lot and a fresh sale is allowed.
        terminalId = stamped.id;
      } else throw e;
    }
    if (landed) throw new StockUnavailableError("lot_closed");
  }

  // A sell already in flight for this lot is RE-SERVED, never rebuilt: two live sell transactions
  // for one lot would both leave the wallet, but only the first can be booked against the lot — the
  // second would quietly sell ANOTHER lot of the same mint and could never be settled. The same
  // bytes carry the same signature, so a retry is idempotent on chain. This read is the cheap path
  // (it skips a quote and a build); the decision that counts is the locked one below.
  const pending = await pendingSell(prisma, user.id, lot.id);
  if (pending && pending.id !== terminalId && pending.unsignedTx && height <= Number(pending.lastValidBlockHeight)) {
    return reservedSell(pending, payer);
  }

  // The wallet must still hold the lot. If it does not, the user moved or sold it elsewhere: close
  // what the chain says (reconcile) and tell the client the lot is gone rather than quoting a sale
  // that cannot settle.
  const accounts = await getTokenAccounts(payer, lot.asset.mint);
  let held = 0n;
  for (const a of accounts) held += a.amount;
  if (held < lot.qtyBase) {
    await reconcileRealLots(user.id, payer);
    throw new StockUnavailableError("lot_moved");
  }

  const quote = await quoteSwap({
    inputMint: lot.asset.mint,
    outputMint: USDC_MINT,
    amount: lot.qtyBase,
    slippageBps: STOCK_SWAP_SLIPPAGE_BPS,
  });
  if (quote.priceImpactBp > STOCK_MAX_PRICE_IMPACT_BP) throw new StockUnavailableError("price_impact");

  // Selling the wallet's ENTIRE holding of this mint: close the emptied account in the same tx so
  // the ~0.00157 SOL of rent comes back — to WHOEVER fronted it (the sponsor only when it opened the
  // account; a user who funded their own keeps it). Only when exactly one account holds exactly the
  // lot — anything else and we do not know what else lives in there.
  const extraInstructions: JupIx[] = [];
  let closeAta = false;
  if (held === lot.qtyBase && accounts.length === 1 && accounts[0].pubkey) {
    const mintAcc = await getAccountInfoBase64(lot.asset.mint);
    if (mintAcc) {
      // Provenance is per ACCOUNT, not per lot: the account may have been opened by an OLDER buy,
      // and this lot's own rentFromSponsor would then hand the sponsor's rent to the user.
      const funded = await prisma.sponsorFundedAccount.findFirst({
        where: { account: accounts[0].pubkey, confirmedAt: { not: null }, closedAt: null },
        select: { account: true },
      });
      closeAta = true;
      extraInstructions.push(
        closeAccountIx({
          tokenProgram: mintAcc.owner, // Token or Token-2022 — CloseAccount is the same opcode in both
          account: accounts[0].pubkey,
          destination: funded ? sponsorAddress()! : payer,
          owner: payer,
        }),
      );
    }
  }

  const tx = await buildSponsoredSwapTx({ quoteResponse: quote.raw, userPublicKey: payer, extraInstructions });

  const { attempt, reserved } = await createAttempt(
    {
      userId: user.id,
      assetId: lot.assetId,
      payer,
      kind: "SELL",
      positionId: lot.id,
      sponsored: true,
      stakeCents: lot.costCents, // what the lot cost — the basis the P&L is measured against
      inAmountMicro: lot.qtyBase, // SELL: RAW xStock in (see the schema comment)
      minOutBase: quote.minOutBase, // SELL: MINIMUM USDC micro out
      msgHash: tx.messageHash,
      unsignedTx: tx.swapTransaction, // a retry re-serves THESE bytes (see the in-flight branch above)
      closeAta, // the confirm retires the account's funding row off this
      lastValidBlockHeight: BigInt(tx.lastValidBlockHeight),
    },
    // The decision that counts, under this user's advisory lock: whatever the cheap read above saw,
    // a concurrent build may have inserted its own sell in the meantime. Re-serve it rather than add
    // a second live sale of one lot.
    async (db) => {
      const live = await pendingSell(db, user.id, lot.id);
      if (!live) return null;
      if (live.id !== terminalId && live.unsignedTx && height <= Number(live.lastValidBlockHeight)) return live;
      // Past its block height, resolved as terminal above, or a legacy row with no bytes to
      // re-serve: it can never settle this lot. Conditional — a confirm may have won the race.
      await db.stockBuyAttempt.updateMany({
        where: { id: live.id, status: "PENDING" },
        data: { status: "EXPIRED", resolvedAt: new Date() },
      });
      await dropUnconfirmedFunding(live.id, db);
      return null;
    },
  );
  if (reserved) return reservedSell(attempt, payer);
  await recordSponsorFunding(attempt, tx.fundedAccounts);

  return {
    attemptId: attempt.id,
    swapTransaction: tx.swapTransaction,
    lastValidBlockHeight: tx.lastValidBlockHeight,
    payer,
    feePayer: sponsorAddress()!,
    quote: {
      inAmountBase: String(quote.inAmount),
      outAmountMicro: String(quote.outAmount),
      minOutMicro: String(quote.minOutBase),
      priceImpactBp: quote.priceImpactBp,
    },
  };
}

// ─── submit (the sponsored send) ────────────────────────────────────────────────────────────────────

// Co-sign the user-signed transaction and send it. The attempt's msgHash is the ONLY authorisation:
// coSignAndSend refuses anything whose message is not byte-identical to what we built.
export async function submitSigned(userId: string, attemptId: string, signedTransactionB64: string): Promise<string> {
  const attempt = await prisma.stockBuyAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.userId !== userId) throw new AttemptNotFoundError();
  if (attempt.status !== "PENDING") throw new TxRejectedError("attempt_not_pending");
  // A self-paid attempt was never ours to sign (and its msgHash is over different bytes entirely).
  if (!attempt.sponsored) throw new TxRejectedError("tx_mismatch");

  // Past its blockhash the tx can never land; sending it would just burn a sponsor fee on a retry.
  const height = await getBlockHeight();
  if (height > Number(attempt.lastValidBlockHeight)) throw new TxRejectedError("attempt_expired");

  // SELL: the lot must still be ours to sell. An older attempt for a lot that a newer one already
  // closed would sell the wallet's OTHER tokens of the same mint and could never be booked, so it
  // is refused here — the last point before the sponsor signature makes it sendable by anyone.
  if (attempt.kind === "SELL") {
    await prisma.$transaction(async (db) => {
      const lot = attempt.positionId ? await db.stockPosition.findUnique({ where: { id: attempt.positionId } }) : null;
      if (!lot || lot.userId !== userId || lot.closedAt) throw new TxRejectedError("lot_closed");
      const settled = await db.stockBuyAttempt.count({
        where: { positionId: attempt.positionId, kind: "SELL", status: "CONFIRMED", id: { not: attempt.id } },
      });
      if (settled > 0) throw new TxRejectedError("lot_closed");
    });
  }

  const { wire, sig } = await coSign({
    signedTransactionB64,
    expectedMessageHash: attempt.msgHash,
    userAddress: attempt.payer,
  });
  // Stamp BEFORE the send. The signature is already decided (it is the fee payer's), and a send that
  // times out after the broadcast would otherwise leave a swap on chain that no row points at: the
  // client would retry and buy twice. A stamped PENDING attempt is exactly what the sweep recovers.
  await stampSig(userId, attemptId, sig);
  await sendRawTransaction(wire);
  return sig;
}

// ─── sent ───────────────────────────────────────────────────────────────────────────────────────────

// INTERNAL: bind a signature to an attempt. The only caller that may do this for a SPONSORED attempt
// is submitSigned, because there the signature is the server's OWN (the fee payer's, computed from
// the bytes it is about to send) — never a value that came from a client.
async function stampSig(userId: string, attemptId: string, sig: string): Promise<void> {
  const attempt = await prisma.stockBuyAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.userId !== userId) throw new AttemptNotFoundError();
  if (!sigBytesValid(sig)) throw new RangeError("bad_sig");
  if (attempt.sig === null) {
    await prisma.stockBuyAttempt.update({ where: { id: attemptId }, data: { sig } });
  } else if (attempt.sig !== sig) {
    throw new TxRejectedError("not_this_buy");
  }
}

// PUBLIC (POST /api/stocks/real/sent): the wallet SENT a self-paid transaction itself and reports
// its signature, so the sweep can recover a buy whose tab died before /confirm.
//
// A sponsored attempt is refused outright: its signature belongs to us. Accepting a client-sent one
// would let anyone stamp an arbitrary landed transaction onto an unsent sponsored attempt — and the
// sweep, which trusts a stamped signature, would then confirm it against that receipt. -> 409.
export async function markSent(userId: string, attemptId: string, sig: string): Promise<void> {
  const attempt = await prisma.stockBuyAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.userId !== userId) throw new AttemptNotFoundError();
  if (!sigBytesValid(sig)) throw new RangeError("bad_sig");
  if (attempt.sponsored) throw new TxRejectedError("not_self_paid");
  await stampSig(userId, attemptId, sig);
}

// ─── confirm ────────────────────────────────────────────────────────────────────────────────────────

export interface ConfirmOpts {
  polls?: number;
  sleepMs?: number;
}

// Poll for the landed transaction. Shared by BUY and SELL: neither books anything off a tx it has
// not actually read.
async function landedTx(sig: string, polls: number, sleepMs: number): Promise<RpcParsedTx> {
  for (let i = 0; i < polls; i++) {
    const tx = await getTransaction(sig);
    if (tx) return tx;
    if (i < polls - 1) await sleep(sleepMs);
  }
  throw new TxNotFoundError();
}

export async function confirmAttempt(
  userId: string,
  attemptId: string,
  sig: string,
  opts: ConfirmOpts = {},
): Promise<StockRealConfirmResponse> {
  const polls = opts.polls ?? STOCK_CONFIRM_POLLS;
  const sleepMs = opts.sleepMs ?? 1_500;

  const attempt = await prisma.stockBuyAttempt.findUnique({ where: { id: attemptId }, include: { asset: true } });
  if (!attempt || attempt.userId !== userId) throw new AttemptNotFoundError();
  if (!sigBytesValid(sig)) throw new RangeError("bad_sig");

  // A receipt only ever speaks for the attempt it belongs to. Sponsored: the server stamped the
  // signature itself before sending (submitSigned), so ANY other signature is a different
  // transaction — refuse it BEFORE the kind dispatch, or a SELL could be confirmed (or marked
  // FAILED) off any transaction its payer happens to have signed.
  if (attempt.sponsored && attempt.sig !== sig) throw new TxRejectedError("not_this_buy");

  if (attempt.kind === "SELL") return confirmSell(attempt, sig, polls, sleepMs);

  // Already CONFIRMED: return the existing lot iff it is THIS signature.
  if (attempt.status === "CONFIRMED") {
    const lot = await prisma.stockPosition.findUnique({ where: { attemptId } });
    if (lot && lot.txSig === sig) {
      return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: true, kind: "BUY" };
    }
    throw new TxRejectedError("not_this_buy");
  }
  if (attempt.status === "EXPIRED") throw new TxRejectedError("attempt_expired");
  if (attempt.status === "FAILED") throw new TxRejectedError("attempt_failed");

  // A prior lot for this signature (idempotent replay across attempts).
  const prior = await prisma.stockPosition.findUnique({ where: { txSig: sig } });
  if (prior) {
    if (prior.userId === userId && prior.attemptId === attemptId) {
      return { positionId: prior.id, qtyBase: String(prior.qtyBase), costCents: prior.costCents, alreadyConfirmed: true, kind: "BUY" };
    }
    throw new TxRejectedError("not_this_buy");
  }

  const tx = await landedTx(sig, polls, sleepMs);

  // A failed tx books nothing and marks the attempt FAILED.
  if (tx.meta?.err != null) {
    // Self-paid: nothing has bound this signature to the attempt yet. A failed transaction our payer
    // did not even sign says nothing about this buy — and the real one may still be in flight.
    if (!attempt.sponsored && !signedBy(tx, attempt.payer)) throw new TxRejectedError("not_this_buy");
    await prisma.stockBuyAttempt.update({
      where: { id: attemptId },
      data: { status: "FAILED", sig, resolvedAt: new Date() },
    });
    await dropUnconfirmedFunding(attemptId); // a failed swap created no token account
    void captureToGlitchTip(new Error("stock buy attempt FAILED on chain"), { subsystem: "stocks", attemptId, userId, sig });
    throw new TxRejectedError("tx_failed");
  }

  // The landed tx must match the attempt we built. If it does not, do NOT mark the attempt failed —
  // the real tx may still be in flight.
  const delta = parseSwapDelta(tx, { payer: attempt.payer, mint: attempt.asset.mint });
  if (!delta || !attemptMatches(delta, { inAmountMicro: attempt.inAmountMicro, minOutBase: attempt.minOutBase })) {
    // A landed tx that is not the swap we built. Booked nothing; worth a human look (a wallet
    // that signed something else, or a quote/route drift we do not expect).
    void captureToGlitchTip(new Error("stock buy: landed tx does not match the attempt"), { subsystem: "stocks", attemptId, userId, sig });
    throw new TxRejectedError("not_this_buy");
  }

  const costCents = usdcMicroToCents(delta.usdcOutMicro);
  const entry = entryPriceCents(costCents, delta.qtyBase, attempt.asset.decimals);
  const now = new Date();

  const book = (hedgeSuggestionId: string | null): Promise<StockRealConfirmResponse> =>
    prisma.$transaction(async (db) => {
      const fresh = await db.stockBuyAttempt.findUnique({ where: { id: attemptId } });
      if (!fresh) throw new AttemptNotFoundError();
      if (fresh.status !== "PENDING") {
        const lot = await db.stockPosition.findUnique({ where: { attemptId } });
        if (lot) {
          return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: true, kind: "BUY" };
        }
        throw new TxRejectedError("not_this_buy");
      }
      const lot = await db.stockPosition.create({
        data: {
          userId,
          assetId: attempt.assetId,
          mode: "REAL",
          source: hedgeSuggestionId ? "HEDGE" : "DECK",
          hedgeSuggestionId,
          qtyBase: delta.qtyBase,
          costCents,
          entryPriceCents: entry,
          txSig: sig,
          payer: attempt.payer,
          rentFromSponsor: attempt.rentFromSponsor, // the sell returns the rent to whoever fronted it
          attemptId,
          walletCheckedAt: now,
        },
      });
      await db.stockBuyAttempt.update({
        where: { id: attemptId },
        data: { status: "CONFIRMED", sig, resolvedAt: now },
      });
      // The swap landed, so the accounts this attempt funded really exist and the sponsor really
      // paid their rent: from here the sell that empties one owes the refund to the sponsor.
      await db.sponsorFundedAccount.updateMany({ where: { attemptId, confirmedAt: null }, data: { confirmedAt: now } });
      return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: false, kind: "BUY" };
    });

  // P2002 = unique violation on txSig / attemptId / userId_hedgeSuggestionId — a concurrent confirm
  // won the race. Re-read by txSig and return the existing lot iff it belongs to this user+attempt.
  const afterP2002 = async (e: unknown): Promise<StockRealConfirmResponse> => {
    if (!isP2002(e)) throw e;
    const lot = await prisma.stockPosition.findUnique({ where: { txSig: sig } });
    if (lot && lot.userId === userId && lot.attemptId === attemptId) {
      return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: true, kind: "BUY" };
    }
    throw new TxRejectedError("not_this_buy");
  };

  try {
    return await book(attempt.hedgeSuggestionId);
  } catch (e) {
    // The [userId, hedgeSuggestionId] unique spans PAPER and REAL: the same suggestion accepted on
    // paper first makes this create throw. The swap already LANDED — a landed swap is always booked,
    // so the lot keeps the money and loses only the back-reference to the suggestion.
    if (attempt.hedgeSuggestionId && isP2002(e, "hedgeSuggestionId")) {
      return await book(null).catch(afterP2002);
    }
    return await afterP2002(e);
  }
}

// Prisma's unique-violation error, optionally narrowed to one of the offending columns.
function isP2002(e: unknown, column?: string): boolean {
  if (!e || typeof e !== "object" || !("code" in e) || (e as { code: string }).code !== "P2002") return false;
  return column === undefined || String((e as { meta?: { target?: unknown } }).meta?.target ?? "").includes(column);
}

// ─── confirm (SELL) ─────────────────────────────────────────────────────────────────────────────────

function sellResponse(
  lot: { id: string; costCents: number; proceedsCents: number | null; pnlCents: number | null; qtyBase: bigint },
  qtyBase: bigint,
  alreadyConfirmed: boolean,
): StockRealConfirmResponse {
  return {
    positionId: lot.id,
    qtyBase: String(qtyBase),
    costCents: lot.costCents,
    proceedsCents: lot.proceedsCents ?? 0,
    pnlCents: lot.pnlCents ?? 0,
    alreadyConfirmed,
    kind: "SELL",
  };
}

// The mirror of the BUY confirm: read the landed tx, match it against the SELL attempt, and close
// the lot with what the chain actually paid out. Proceeds FLOOR the USDC received, so realized P&L
// can never read higher than the wallet's own balance change.
async function confirmSell(
  attempt: Prisma.StockBuyAttemptGetPayload<{ include: { asset: true } }>,
  sig: string,
  polls: number,
  sleepMs: number,
): Promise<StockRealConfirmResponse> {
  const userId = attempt.userId;
  const positionId = attempt.positionId;
  if (!positionId) throw new TxRejectedError("not_this_buy"); // a SELL attempt with no lot is corrupt

  // The receipt binding again, before ANY mutation: a sponsored sell can only ever be the signature
  // the server sent. confirmAttempt checks this too — this is the guard for any future caller.
  if (attempt.sponsored && attempt.sig !== sig) throw new TxRejectedError("not_this_buy");

  // Idempotent by signature: the lot carries the sell that closed it.
  const prior = await prisma.stockPosition.findUnique({ where: { sellTxSig: sig } });
  if (prior) {
    if (prior.userId === userId && prior.id === positionId) return sellResponse(prior, prior.qtyBase, true);
    throw new TxRejectedError("not_this_buy");
  }
  if (attempt.status === "CONFIRMED") throw new TxRejectedError("not_this_buy"); // settled by a DIFFERENT sig
  if (attempt.status === "EXPIRED") throw new TxRejectedError("attempt_expired");
  if (attempt.status === "FAILED") throw new TxRejectedError("attempt_failed");

  const tx = await landedTx(sig, polls, sleepMs);

  if (tx.meta?.err != null) {
    // A failed transaction our payer did not sign is not this sell failing — marking the attempt
    // FAILED off it would strand a sale that is still in flight.
    if (!signedBy(tx, attempt.payer)) throw new TxRejectedError("not_this_buy");
    await prisma.stockBuyAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", sig, resolvedAt: new Date() },
    });
    await dropUnconfirmedFunding(attempt.id);
    void captureToGlitchTip(new Error("stock sell attempt FAILED on chain"), {
      subsystem: "stocks",
      attemptId: attempt.id,
      userId,
      sig,
    });
    throw new TxRejectedError("tx_failed");
  }

  const delta = parseSellDelta(tx, { payer: attempt.payer, mint: attempt.asset.mint });
  // SELL units: inAmountMicro is the RAW stock sold, minOutBase the MINIMUM USDC micro out.
  if (!delta || !sellMatches(delta, { inAmountBase: attempt.inAmountMicro, minOutMicro: attempt.minOutBase })) {
    void captureToGlitchTip(new Error("stock sell: landed tx does not match the attempt"), {
      subsystem: "stocks",
      attemptId: attempt.id,
      userId,
      sig,
    });
    throw new TxRejectedError("not_this_buy");
  }

  const proceedsCents = usdcMicroToCentsFloor(delta.usdcInMicro);
  const now = new Date();

  try {
    return await prisma.$transaction(async (db) => {
      // The same per-user lock the reconciler takes: closing this lot and deciding which lots the
      // wallet still backs are ONE decision. Without it the reconciler can read balances, this
      // confirm can close lot A, and the reconciler then closes lot B off a set that no longer holds.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const lot = await db.stockPosition.findUnique({ where: { id: positionId } });
      if (!lot || lot.userId !== userId) throw new TxRejectedError("not_this_buy");
      const pnlCents = proceedsCents - lot.costCents;

      // Conditional close: only the FIRST confirm flips closedAt.
      const closed = await db.stockPosition.updateMany({
        where: { id: positionId, userId, mode: "REAL", closedAt: null },
        data: { closedAt: now, closeReason: "sold", proceedsCents, pnlCents, sellTxSig: sig },
      });
      if (closed.count === 0) {
        // Already closed. Either the reconciler saw the balance drop before this confirm arrived —
        // in which case the lot is closed as "wallet" with no proceeds and this IS its receipt — or
        // someone else closed it and the sale is not ours to book.
        const adopted = await db.stockPosition.updateMany({
          where: { id: positionId, userId, mode: "REAL", sellTxSig: null, closeReason: "wallet" },
          data: { closeReason: "sold", proceedsCents, pnlCents, sellTxSig: sig },
        });
        if (adopted.count === 0) {
          const fresh = await db.stockPosition.findUnique({ where: { id: positionId } });
          if (!fresh || fresh.sellTxSig !== sig) throw new TxRejectedError("not_this_buy");
          await db.stockBuyAttempt.updateMany({
            where: { id: attempt.id, status: "PENDING" },
            data: { status: "CONFIRMED", sig, resolvedAt: now },
          });
          return sellResponse(fresh, delta.qtyBase, true);
        }
      }
      // This tx carried the close-account instruction: the account is gone and its rent is back with
      // whoever fronted it, so its funding row retires with it. (payer+mint identifies the account —
      // a wallet holds at most one open sponsor-funded account per mint.)
      if (attempt.closeAta) {
        await db.sponsorFundedAccount.updateMany({
          where: { payer: attempt.payer, mint: attempt.asset.mint, closedAt: null },
          data: { closedAt: now },
        });
      }
      await db.stockBuyAttempt.update({
        where: { id: attempt.id },
        data: { status: "CONFIRMED", sig, resolvedAt: now },
      });
      return sellResponse({ ...lot, proceedsCents, pnlCents }, delta.qtyBase, false);
    });
  } catch (e) {
    // P2002 = the unique sellTxSig — a concurrent confirm won the race.
    if (isP2002(e)) {
      const lot = await prisma.stockPosition.findUnique({ where: { sellTxSig: sig } });
      if (lot && lot.userId === userId && lot.id === positionId) return sellResponse(lot, delta.qtyBase, true);
      throw new TxRejectedError("not_this_buy");
    }
    throw e;
  }
}

// ─── sweep ──────────────────────────────────────────────────────────────────────────────────────────

// Is this landed tx the one the attempt was built for? BUY and SELL read the same tx from opposite
// ends, so the sweep asks one question and the kind picks the reader.
function landedMatchesAttempt(
  attempt: Prisma.StockBuyAttemptGetPayload<{ include: { asset: true } }>,
  tx: RpcParsedTx,
): boolean {
  const expect = { payer: attempt.payer, mint: attempt.asset.mint };
  if (attempt.kind === "SELL") {
    const d = parseSellDelta(tx, expect);
    return d !== null && sellMatches(d, { inAmountBase: attempt.inAmountMicro, minOutMicro: attempt.minOutBase });
  }
  const d = parseSwapDelta(tx, expect);
  return d !== null && attemptMatches(d, { inAmountMicro: attempt.inAmountMicro, minOutBase: attempt.minOutBase });
}

export async function sweepAttempts(
  now = new Date(),
): Promise<{ scanned: number; confirmed: number; expired: number; failed: number }> {
  const cutoff = new Date(now.getTime() - STOCK_ATTEMPT_SWEEP_AFTER_MS);
  const attempts = await prisma.stockBuyAttempt.findMany({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: 50,
    include: { asset: true },
  });

  let confirmed = 0;
  let expired = 0;
  let failed = 0;
  if (attempts.length === 0) return { scanned: 0, confirmed, expired, failed };

  // One block-height read for the whole sweep. A Helius outage aborts the sweep (throw).
  const height = await getBlockHeight();

  // EXPIRE only a row that is still PENDING: this sweep's snapshot is minutes old by now, and a
  // confirm that landed in between must not be overwritten with EXPIRED.
  const expire = async (id: string): Promise<void> => {
    const res = await prisma.stockBuyAttempt.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "EXPIRED", resolvedAt: now },
    });
    if (res.count === 1) expired++;
    await dropUnconfirmedFunding(id);
  };

  // A STAMPED attempt whose receipt can never be booked (it is not this attempt's transaction, or it
  // landed with an error) is finished: leaving it PENDING keeps it in the oldest-50 window for ever
  // and starves every later attempt of a slot. Conditional, and loud — a signed transaction that
  // resolved to nothing is a real user's real USDC.
  const fail = async (id: string, code: string): Promise<void> => {
    const res = await prisma.stockBuyAttempt.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "FAILED", resolvedAt: now },
    });
    if (res.count === 1) {
      failed++;
      void captureToGlitchTip(new Error(`stock attempt stuck on ${code} — FAILED by the sweep`), {
        subsystem: "stocks",
        attemptId: id,
        code,
      });
    }
    await dropUnconfirmedFunding(id);
  };

  for (const attempt of attempts) {
    try {
      if (attempt.sig) {
        await confirmAttempt(attempt.userId, attempt.id, attempt.sig, { polls: 1, sleepMs: 0 });
        confirmed++;
        continue;
      }
      if (height > Number(attempt.lastValidBlockHeight)) {
        // Past the block height with no sig: search the payer's recent signatures for a match.
        const sigs = await getSignaturesForAddress(attempt.payer, 25);
        const floor = attempt.createdAt.getTime() - 60_000;
        let matched = false;
        for (const s of sigs) {
          if (s.err != null) continue;
          if (s.blockTime != null && s.blockTime * 1000 < floor) continue;
          const tx = await getTransaction(s.signature);
          if (!tx) continue;
          if (!landedMatchesAttempt(attempt, tx)) continue;
          try {
            await confirmAttempt(attempt.userId, attempt.id, s.signature, { polls: 1, sleepMs: 0 });
            confirmed++;
            matched = true;
            break;
          } catch (e) {
            // This receipt cannot be booked against this attempt (it already belongs to another
            // one, say). Try the next signature — throwing here would leave the row PENDING for
            // ever and hold a slot in every future sweep.
            if (e instanceof TxRejectedError) continue;
            throw e;
          }
        }
        if (!matched) await expire(attempt.id);
      }
      // else: not yet past the block height, no sig — skip (a later sweep may still match).
    } catch (e) {
      if (e instanceof TxNotFoundError) {
        if (height > Number(attempt.lastValidBlockHeight)) await expire(attempt.id);
        continue;
      }
      if (e instanceof TxRejectedError) {
        if (e.message === "tx_failed") {
          failed++; // confirmAttempt already marked the row FAILED off the landed error
          await dropUnconfirmedFunding(attempt.id);
        } else if (attempt.sig && e.message === "not_this_buy") {
          // The stamped signature landed as something else: this attempt is spent (see fail()).
          await fail(attempt.id, e.message);
        }
        // anything else -> skip (keep PENDING; a later sweep may still match)
        continue;
      }
      console.warn(`sweepAttempts: attempt ${attempt.id} failed: ${(e as Error).message}`);
    }
  }

  return { scanned: attempts.length, confirmed, expired, failed };
}

// ─── reconcile ──────────────────────────────────────────────────────────────────────────────────────

export async function reconcileRealLots(
  userId: string,
  payer: string,
  now = new Date(),
): Promise<{ closed: number }> {
  const lots = await prisma.stockPosition.findMany({
    where: { userId, payer, mode: "REAL", closedAt: null },
    include: { asset: true },
    orderBy: { createdAt: "desc" },
  });
  if (lots.length === 0) return { closed: 0 };

  // Group by mint (one mint = one asset: StockAsset.mint is unique).
  const byMint = new Map<string, typeof lots>();
  for (const lot of lots) {
    const arr = byMint.get(lot.asset.mint) ?? [];
    arr.push(lot);
    byMint.set(lot.asset.mint, arr);
  }

  let closed = 0;
  for (const [mint, group] of byMint) {
    const assetId = group[0].assetId;
    // The balance read is RPC and stays OUTSIDE the transaction — holding this user's lock across a
    // network call would block their own confirms.
    const bal = await getTokenBalanceRaw(payer, mint);
    closed += await prisma.$transaction(async (db) => {
      // Everything a confirmSell also takes, so the two cannot interleave: a sale landing between
      // the balance read and this decision closes lot A, and closing "the rest" off the stale set
      // would then close lot B — a lot the wallet still backs.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

      // A sell in flight makes the balance a moving target: the tokens can already be gone while the
      // lot they belong to is still open (its confirm is seconds away). Every mint with a live sell
      // is left entirely alone, walletCheckedAt included, until the sale resolves.
      const selling = await db.stockBuyAttempt.count({
        where: {
          payer,
          assetId,
          kind: "SELL",
          status: "PENDING",
          createdAt: { gte: new Date(now.getTime() - 2 * 3_600_000) },
        },
      });
      if (selling > 0) return 0;

      // Re-read under the lock. If the open set moved since the balance was read, the balance no
      // longer describes it — skip this mint and let the next pass decide on a consistent pair.
      const fresh = await db.stockPosition.findMany({
        where: { userId, payer, assetId, mode: "REAL", closedAt: null },
        orderBy: { createdAt: "desc" },
      });
      const same = fresh.length === group.length && fresh.every((f) => group.some((g) => g.id === f.id));
      if (!same) return 0;

      let need = 0n;
      for (const lot of fresh) need += lot.qtyBase;
      if (bal >= need) {
        // All backed — stamp walletCheckedAt on the survivors.
        await db.stockPosition.updateMany({
          where: { id: { in: fresh.map((l) => l.id) }, closedAt: null },
          data: { walletCheckedAt: now },
        });
        return 0;
      }
      // Close newest-first until the remaining sum fits under the live balance.
      let remaining = need;
      const toClose: string[] = [];
      for (const lot of fresh) {
        if (remaining <= bal) break;
        toClose.push(lot.id);
        remaining -= lot.qtyBase;
      }
      let count = 0;
      if (toClose.length > 0) {
        const res = await db.stockPosition.updateMany({
          where: { id: { in: toClose }, closedAt: null },
          data: { closedAt: now, closeReason: "wallet" },
        });
        count = res.count;
      }
      // Stamp the survivors.
      const survivors = fresh.filter((l) => !toClose.includes(l.id)).map((l) => l.id);
      if (survivors.length > 0) {
        await db.stockPosition.updateMany({
          where: { id: { in: survivors }, closedAt: null },
          data: { walletCheckedAt: now },
        });
      }
      return count;
    });
  }

  return { closed };
}
