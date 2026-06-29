-- CreateEnum
CREATE TYPE "MarketSource" AS ENUM ('POLYMARKET', 'TXODDS');

-- AlterTable
ALTER TABLE "markets" ADD COLUMN     "onchainRef" TEXT,
ADD COLUMN     "source" "MarketSource" NOT NULL DEFAULT 'POLYMARKET',
ADD COLUMN     "verifiedOnChain" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "markets_source_status_resolutionDeadline_idx" ON "markets"("source", "status", "resolutionDeadline");
