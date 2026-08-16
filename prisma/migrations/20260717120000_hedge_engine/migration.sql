-- Hedge Suggestion Engine (phase 2, workstream A). Additive only: a new BetSource enum value,
-- three new hedge enums, a nullable Bet.hedgeSuggestionId, and four new tables. No existing
-- column/flow changes -> deck/swipe/feed/settle behaviour is untouched. Hand-written to match
-- schema.prisma (Docker/DB not reachable in the authoring env); `prisma migrate deploy` applies it.
-- Note: HEDGE is added to the BetSource enum but NOT used within this migration, so the new value
-- is safe inside Prisma's per-migration transaction (PG12+ only forbids USING a value in the same tx).

-- AlterEnum
ALTER TYPE "BetSource" ADD VALUE 'HEDGE';

-- CreateEnum
CREATE TYPE "HedgeSuggestionKind" AS ENUM ('S1_MAJOR', 'S1_PROXY', 'S2', 'FALLBACK');

-- CreateEnum
CREATE TYPE "HedgeMarketDirection" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "HedgeEventType" AS ENUM ('IMPRESSION', 'ACCEPT', 'DISMISS');

-- AlterTable
ALTER TABLE "bets" ADD COLUMN     "hedgeSuggestionId" TEXT;

-- CreateTable
CREATE TABLE "hedge_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hedge_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_snapshots" (
    "address" TEXT NOT NULL,
    "exposure" JSONB NOT NULL,
    "avgCost" JSONB,
    "totalNotionalCents" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pnlFetchedAt" TIMESTAMP(3),

    CONSTRAINT "wallet_snapshots_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "market_meta" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "asset" TEXT,
    "tagSlug" TEXT,
    "eventSlug" TEXT,
    "eventTicker" TEXT,
    "series" TEXT,
    "strikeCents" INTEGER,
    "direction" "HedgeMarketDirection",
    "parsedDeadline" TIMESTAMP(3),
    "liquidityCents" INTEGER,
    "volumeCents" INTEGER,
    "parseOk" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hedge_suggestion_events" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "kind" "HedgeSuggestionKind" NOT NULL,
    "side" "BetSide" NOT NULL,
    "proposedStakeCents" INTEGER NOT NULL,
    "event" "HedgeEventType" NOT NULL,
    "betId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hedge_suggestion_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bets_userId_hedgeSuggestionId_idx" ON "bets"("userId", "hedgeSuggestionId");

-- CreateIndex
CREATE INDEX "hedge_wallets_address_idx" ON "hedge_wallets"("address");

-- CreateIndex
CREATE UNIQUE INDEX "hedge_wallets_userId_address_key" ON "hedge_wallets"("userId", "address");

-- CreateIndex
CREATE INDEX "market_meta_asset_parseOk_idx" ON "market_meta"("asset", "parseOk");

-- CreateIndex
CREATE UNIQUE INDEX "market_meta_marketId_key" ON "market_meta"("marketId");

-- CreateIndex
CREATE INDEX "hedge_suggestion_events_suggestionId_idx" ON "hedge_suggestion_events"("suggestionId");

-- CreateIndex
CREATE INDEX "hedge_suggestion_events_userId_createdAt_idx" ON "hedge_suggestion_events"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "hedge_suggestion_events_userId_suggestionId_event_key" ON "hedge_suggestion_events"("userId", "suggestionId", "event");

-- AddForeignKey
ALTER TABLE "hedge_wallets" ADD CONSTRAINT "hedge_wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_meta" ADD CONSTRAINT "market_meta_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hedge_suggestion_events" ADD CONSTRAINT "hedge_suggestion_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hedge_suggestion_events" ADD CONSTRAINT "hedge_suggestion_events_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
