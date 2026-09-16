-- Rent provenance per ACCOUNT, plus the flag that tells a sell confirm the account was closed.
-- Additive only, no backfill: with no rows on record every close falls back to the payer, which is
-- the safe side (the user keeps rent we may have fronted before this migration).
--   sponsor_funded_accounts — one row per token account the sponsor's rent opened. A lot cannot
--                             carry this: buy A opens the account, buy B shares it, and the sell
--                             that closes it may be B's (whose own rentFromSponsor is false).
--   stock_buy_attempts.closeAta — this SELL closes the emptied token account.
-- AlterTable
ALTER TABLE "stock_buy_attempts" ADD COLUMN     "closeAta" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "sponsor_funded_accounts" (
    "account" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "attemptId" TEXT,
    "fundedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "sponsor_funded_accounts_pkey" PRIMARY KEY ("account")
);

-- CreateIndex
CREATE INDEX "sponsor_funded_accounts_payer_mint_idx" ON "sponsor_funded_accounts"("payer", "mint");
