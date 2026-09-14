-- CreateEnum
CREATE TYPE "StockAttemptStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HedgeSuggestionKind" ADD VALUE 'S1_STOCK';
ALTER TYPE "HedgeSuggestionKind" ADD VALUE 'S3_STOCK';
ALTER TYPE "HedgeSuggestionKind" ADD VALUE 'SPOTTED';

-- DropForeignKey
ALTER TABLE "hedge_suggestion_events" DROP CONSTRAINT "hedge_suggestion_events_marketId_fkey";

-- AlterTable
ALTER TABLE "hedge_suggestion_events" ADD COLUMN     "positionId" TEXT,
ADD COLUMN     "stockSymbol" TEXT,
ALTER COLUMN "marketId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "stockConsentAt" TIMESTAMP(3),
ADD COLUMN     "stockConsentVersion" INTEGER;

-- CreateTable
CREATE TABLE "stock_assets" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "logoUrl" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 8,
    "halted" BOOLEAN NOT NULL DEFAULT false,
    "tradingHours" TEXT,
    "openNow" BOOLEAN NOT NULL DEFAULT false,
    "priceCents" INTEGER,
    "change24hBp" INTEGER,
    "liquidityCents" INTEGER,
    "uiMultiplierMicro" INTEGER,
    "deckEligible" BOOLEAN NOT NULL DEFAULT false,
    "pricedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "mode" "BetMode" NOT NULL DEFAULT 'PAPER',
    "source" "BetSource" NOT NULL DEFAULT 'DECK',
    "requestId" TEXT,
    "hedgeSuggestionId" TEXT,
    "qtyBase" BIGINT NOT NULL,
    "costCents" INTEGER NOT NULL,
    "entryPriceCents" INTEGER NOT NULL,
    "txSig" TEXT,
    "payer" TEXT,
    "attemptId" TEXT,
    "walletCheckedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "proceedsCents" INTEGER,
    "pnlCents" INTEGER,
    "alertTierBp" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMP(3),
    "alertSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_passes" (
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_passes_pkey" PRIMARY KEY ("userId","assetId")
);

-- CreateTable
CREATE TABLE "stock_buy_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "stakeCents" INTEGER NOT NULL,
    "inAmountMicro" BIGINT NOT NULL,
    "minOutBase" BIGINT NOT NULL,
    "msgHash" TEXT NOT NULL,
    "lastValidBlockHeight" BIGINT NOT NULL,
    "hedgeSuggestionId" TEXT,
    "status" "StockAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "sig" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "stock_buy_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "life_situations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountCents" INTEGER,
    "period" TEXT,
    "distanceKm" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "life_situations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_assets_mint_key" ON "stock_assets"("mint");

-- CreateIndex
CREATE UNIQUE INDEX "stock_assets_symbol_key" ON "stock_assets"("symbol");

-- CreateIndex
CREATE INDEX "stock_assets_deckEligible_liquidityCents_idx" ON "stock_assets"("deckEligible", "liquidityCents");

-- CreateIndex
CREATE UNIQUE INDEX "stock_positions_requestId_key" ON "stock_positions"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_positions_txSig_key" ON "stock_positions"("txSig");

-- CreateIndex
CREATE UNIQUE INDEX "stock_positions_attemptId_key" ON "stock_positions"("attemptId");

-- CreateIndex
CREATE INDEX "stock_positions_userId_closedAt_idx" ON "stock_positions"("userId", "closedAt");

-- CreateIndex
CREATE INDEX "stock_positions_assetId_idx" ON "stock_positions"("assetId");

-- CreateIndex
CREATE INDEX "stock_positions_userId_alertSeenAt_idx" ON "stock_positions"("userId", "alertSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_positions_userId_hedgeSuggestionId_key" ON "stock_positions"("userId", "hedgeSuggestionId");

-- CreateIndex
CREATE INDEX "stock_buy_attempts_status_createdAt_idx" ON "stock_buy_attempts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "stock_buy_attempts_userId_createdAt_idx" ON "stock_buy_attempts"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "life_situations_userId_category_key" ON "life_situations"("userId", "category");

-- AddForeignKey
ALTER TABLE "hedge_suggestion_events" ADD CONSTRAINT "hedge_suggestion_events_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_positions" ADD CONSTRAINT "stock_positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_positions" ADD CONSTRAINT "stock_positions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "stock_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_passes" ADD CONSTRAINT "stock_passes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_passes" ADD CONSTRAINT "stock_passes_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "stock_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_buy_attempts" ADD CONSTRAINT "stock_buy_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_buy_attempts" ADD CONSTRAINT "stock_buy_attempts_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "stock_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "life_situations" ADD CONSTRAINT "life_situations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
