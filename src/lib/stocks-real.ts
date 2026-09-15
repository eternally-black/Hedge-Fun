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
import type { Prisma } from "@prisma/client";
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
} from "./helius";
import {
  sponsorConfigured,
  sponsorAddress,
  buildSponsoredSwapTx,
  coSignAndSend,
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
async function assertSponsorQuota(userId: string): Promise<void> {
  const used = await prisma.stockBuyAttempt.count({
    where: { userId, sponsored: true, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
  });
  if (used >= STOCK_SPONSOR_MAX_PER_USER_PER_DAY) throw new SponsorLimitError();
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

  const quote = await quoteSwap({
    inputMint: USDC_MINT,
    outputMint: asset.mint,
    amount: BigInt(p.stakeCents) * 10_000n,
    slippageBps: STOCK_SWAP_SLIPPAGE_BPS,
  });
  if (quote.priceImpactBp > STOCK_MAX_PRICE_IMPACT_BP) throw new StockUnavailableError("price_impact");

  // Sponsored when we hold a key: the tx is OURS (fee payer + ATA rent) and the wallet only signs.
  // Without a key the old self-paid path is unchanged, so the app still works with no sponsor at all.
  const sponsored = sponsorConfigured();
  if (sponsored) await assertSponsorQuota(user.id);
  // Self-paid: the client sends back the very bytes we handed it, so hashing the base64 is enough.
  // Sponsored: the hash is over the compiled MESSAGE, because signing changes the bytes (the
  // signature slots) but never the message.
  const tx = sponsored
    ? await buildSponsoredSwapTx({ quoteResponse: quote.raw, userPublicKey: p.payer })
    : await buildSwapTx(quote.raw, p.payer).then((t) => ({
        ...t,
        messageHash: createHash("sha256").update(t.swapTransaction).digest("hex"),
      }));

  const attempt = await prisma.stockBuyAttempt.create({
    data: {
      userId: user.id,
      assetId: asset.id,
      payer: p.payer,
      kind: "BUY",
      sponsored,
      stakeCents: p.stakeCents,
      inAmountMicro: quote.inAmount,
      minOutBase: quote.minOutBase,
      msgHash: tx.messageHash,
      lastValidBlockHeight: BigInt(tx.lastValidBlockHeight),
      hedgeSuggestionId: p.hedgeSuggestionId ?? null,
    },
  });

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
  await assertSponsorQuota(user.id);

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
  // the ~0.00157 SOL of rent the sponsor fronted at the buy comes back. Only when exactly one
  // account holds exactly the lot — anything else and we do not know what else lives in there.
  const extraInstructions: JupIx[] = [];
  if (held === lot.qtyBase && accounts.length === 1 && accounts[0].pubkey) {
    const mintAcc = await getAccountInfoBase64(lot.asset.mint);
    if (mintAcc) {
      extraInstructions.push(
        closeAccountIx({
          tokenProgram: mintAcc.owner, // Token or Token-2022 — CloseAccount is the same opcode in both
          account: accounts[0].pubkey,
          destination: sponsorAddress()!,
          owner: payer,
        }),
      );
    }
  }

  const tx = await buildSponsoredSwapTx({ quoteResponse: quote.raw, userPublicKey: payer, extraInstructions });

  const attempt = await prisma.stockBuyAttempt.create({
    data: {
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
      lastValidBlockHeight: BigInt(tx.lastValidBlockHeight),
    },
  });

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

  const sig = await coSignAndSend({
    signedTransactionB64,
    expectedMessageHash: attempt.msgHash,
    userAddress: attempt.payer,
  });
  await markSent(userId, attemptId, sig);
  return sig;
}

// ─── sent ───────────────────────────────────────────────────────────────────────────────────────────

export async function markSent(userId: string, attemptId: string, sig: string): Promise<void> {
  const attempt = await prisma.stockBuyAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.userId !== userId) throw new AttemptNotFoundError();
  if (!sigBytesValid(sig)) throw new RangeError("bad_sig");
  if (attempt.sig === null) {
    await prisma.stockBuyAttempt.update({ where: { id: attemptId }, data: { sig } });
  } else if (attempt.sig !== sig) {
    throw new TxRejectedError("not_this_buy");
  }
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
    await prisma.stockBuyAttempt.update({
      where: { id: attemptId },
      data: { status: "FAILED", sig, resolvedAt: new Date() },
    });
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

  try {
    return await prisma.$transaction(async (db) => {
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
          source: attempt.hedgeSuggestionId ? "HEDGE" : "DECK",
          hedgeSuggestionId: attempt.hedgeSuggestionId ?? null,
          qtyBase: delta.qtyBase,
          costCents,
          entryPriceCents: entry,
          txSig: sig,
          payer: attempt.payer,
          attemptId,
          walletCheckedAt: now,
        },
      });
      await db.stockBuyAttempt.update({
        where: { id: attemptId },
        data: { status: "CONFIRMED", sig, resolvedAt: now },
      });
      return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: false, kind: "BUY" };
    });
  } catch (e) {
    // P2002 = unique violation on txSig / attemptId / userId_hedgeSuggestionId — a concurrent confirm
    // won the race. Re-read by txSig and return the existing lot iff it belongs to this user+attempt.
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      const lot = await prisma.stockPosition.findUnique({ where: { txSig: sig } });
      if (lot && lot.userId === userId && lot.attemptId === attemptId) {
        return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: true, kind: "BUY" };
      }
      throw new TxRejectedError("not_this_buy");
    }
    throw e;
  }
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
    await prisma.stockBuyAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", sig, resolvedAt: new Date() },
    });
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
      await db.stockBuyAttempt.update({
        where: { id: attempt.id },
        data: { status: "CONFIRMED", sig, resolvedAt: now },
      });
      return sellResponse({ ...lot, proceedsCents, pnlCents }, delta.qtyBase, false);
    });
  } catch (e) {
    // P2002 = the unique sellTxSig — a concurrent confirm won the race.
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
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
          if (landedMatchesAttempt(attempt, tx)) {
            await confirmAttempt(attempt.userId, attempt.id, s.signature, { polls: 1, sleepMs: 0 });
            confirmed++;
            matched = true;
            break;
          }
        }
        if (!matched) {
          await prisma.stockBuyAttempt.update({
            where: { id: attempt.id },
            data: { status: "EXPIRED", resolvedAt: now },
          });
          expired++;
        }
      }
      // else: not yet past the block height, no sig — skip (a later sweep may still match).
    } catch (e) {
      if (e instanceof TxNotFoundError) {
        if (height > Number(attempt.lastValidBlockHeight)) {
          await prisma.stockBuyAttempt.update({
            where: { id: attempt.id },
            data: { status: "EXPIRED", resolvedAt: now },
          });
          expired++;
        }
        continue;
      }
      if (e instanceof TxRejectedError) {
        if (e.message === "tx_failed") failed++;
        // other TxRejectedError -> skip (keep PENDING; a later sweep may still match)
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

  // Group by mint.
  const byMint = new Map<string, typeof lots>();
  for (const lot of lots) {
    const arr = byMint.get(lot.asset.mint) ?? [];
    arr.push(lot);
    byMint.set(lot.asset.mint, arr);
  }

  let closed = 0;
  for (const [mint, group] of byMint) {
    const bal = await getTokenBalanceRaw(payer, mint);
    let need = 0n;
    for (const lot of group) need += lot.qtyBase;
    if (bal >= need) {
      // All backed — stamp walletCheckedAt on the survivors.
      await prisma.stockPosition.updateMany({
        where: { id: { in: group.map((l) => l.id) }, closedAt: null },
        data: { walletCheckedAt: now },
      });
      continue;
    }
    // Close newest-first until the remaining sum fits under the live balance.
    let remaining = need;
    const toClose: string[] = [];
    for (const lot of group) {
      if (remaining <= bal) break;
      toClose.push(lot.id);
      remaining -= lot.qtyBase;
    }
    if (toClose.length > 0) {
      const res = await prisma.stockPosition.updateMany({
        where: { id: { in: toClose }, closedAt: null },
        data: { closedAt: now, closeReason: "wallet" },
      });
      closed += res.count;
    }
    // Stamp the survivors.
    const survivors = group.filter((l) => !toClose.includes(l.id)).map((l) => l.id);
    if (survivors.length > 0) {
      await prisma.stockPosition.updateMany({
        where: { id: { in: survivors }, closedAt: null },
        data: { walletCheckedAt: now },
      });
    }
  }

  return { closed };
}
