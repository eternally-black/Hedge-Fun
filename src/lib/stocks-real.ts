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

import { createHash } from "node:crypto";
import { isAddress } from "@solana/kit";
import { prisma } from "./prisma";
import {
  USDC_MINT,
  parseSwapDelta,
  attemptMatches,
  usdcMicroToCents,
  entryPriceCents,
  sigBytesValid,
  type RpcParsedTx,
} from "./stocks";
import { quoteSwap, buildSwapTx } from "./jupiter-swap";
import { getTransaction, getSignaturesForAddress, getBlockHeight, getTokenBalanceRaw } from "./helius";
import { verifiedWallets, hasStockConsent, StockUnavailableError } from "./stocks-db";
import {
  STOCK_SWAP_SLIPPAGE_BPS,
  STOCK_MAX_PRICE_IMPACT_BP,
  STOCK_CONFIRM_POLLS,
  STOCK_ATTEMPT_SWEEP_AFTER_MS,
  STOCK_TERMS_VERSION,
} from "./config";
import type { StockRealTxResponse, StockRealConfirmResponse } from "./api-types";

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
// message IS the code: tx_failed | not_this_buy | attempt_expired | attempt_failed
export class TxRejectedError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "TxRejectedError";
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

  const tx = await buildSwapTx(quote.raw, p.payer);
  const msgHash = createHash("sha256").update(tx.swapTransaction).digest("hex");

  const attempt = await prisma.stockBuyAttempt.create({
    data: {
      userId: user.id,
      assetId: asset.id,
      payer: p.payer,
      stakeCents: p.stakeCents,
      inAmountMicro: quote.inAmount,
      minOutBase: quote.minOutBase,
      msgHash,
      lastValidBlockHeight: BigInt(tx.lastValidBlockHeight),
      hedgeSuggestionId: p.hedgeSuggestionId ?? null,
    },
  });

  return {
    attemptId: attempt.id,
    swapTransaction: tx.swapTransaction,
    lastValidBlockHeight: tx.lastValidBlockHeight,
    payer: p.payer,
    quote: {
      inAmountMicro: String(quote.inAmount),
      outAmountBase: String(quote.outAmount),
      minOutBase: String(quote.minOutBase),
      priceImpactBp: quote.priceImpactBp,
    },
  };
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

  // Already CONFIRMED: return the existing lot iff it is THIS signature.
  if (attempt.status === "CONFIRMED") {
    const lot = await prisma.stockPosition.findUnique({ where: { attemptId } });
    if (lot && lot.txSig === sig) {
      return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: true };
    }
    throw new TxRejectedError("not_this_buy");
  }
  if (attempt.status === "EXPIRED") throw new TxRejectedError("attempt_expired");
  if (attempt.status === "FAILED") throw new TxRejectedError("attempt_failed");

  // A prior lot for this signature (idempotent replay across attempts).
  const prior = await prisma.stockPosition.findUnique({ where: { txSig: sig } });
  if (prior) {
    if (prior.userId === userId && prior.attemptId === attemptId) {
      return { positionId: prior.id, qtyBase: String(prior.qtyBase), costCents: prior.costCents, alreadyConfirmed: true };
    }
    throw new TxRejectedError("not_this_buy");
  }

  // Poll for the landed tx.
  let tx: RpcParsedTx | null = null;
  for (let i = 0; i < polls; i++) {
    tx = await getTransaction(sig);
    if (tx) break;
    if (i < polls - 1) await sleep(sleepMs);
  }
  if (!tx) throw new TxNotFoundError();

  // A failed tx books nothing and marks the attempt FAILED.
  if (tx.meta?.err != null) {
    await prisma.stockBuyAttempt.update({
      where: { id: attemptId },
      data: { status: "FAILED", sig, resolvedAt: new Date() },
    });
    throw new TxRejectedError("tx_failed");
  }

  // The landed tx must match the attempt we built. If it does not, do NOT mark the attempt failed —
  // the real tx may still be in flight.
  const delta = parseSwapDelta(tx, { payer: attempt.payer, mint: attempt.asset.mint });
  if (!delta || !attemptMatches(delta, { inAmountMicro: attempt.inAmountMicro, minOutBase: attempt.minOutBase })) {
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
          return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: true };
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
      return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: false };
    });
  } catch (e) {
    // P2002 = unique violation on txSig / attemptId / userId_hedgeSuggestionId — a concurrent confirm
    // won the race. Re-read by txSig and return the existing lot iff it belongs to this user+attempt.
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      const lot = await prisma.stockPosition.findUnique({ where: { txSig: sig } });
      if (lot && lot.userId === userId && lot.attemptId === attemptId) {
        return { positionId: lot.id, qtyBase: String(lot.qtyBase), costCents: lot.costCents, alreadyConfirmed: true };
      }
      throw new TxRejectedError("not_this_buy");
    }
    throw e;
  }
}

// ─── sweep ──────────────────────────────────────────────────────────────────────────────────────────

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
          const delta = parseSwapDelta(tx, { payer: attempt.payer, mint: attempt.asset.mint });
          if (delta && attemptMatches(delta, { inAmountMicro: attempt.inAmountMicro, minOutBase: attempt.minOutBase })) {
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
