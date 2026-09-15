-- Fee-sponsored real stock trades. Additive only: an attempt is now a BUY or a SELL (the sponsor
-- fronts the fee and the ATA rent), and a REAL lot carries the signature of the swap that sold it.
-- CreateEnum
CREATE TYPE "StockAttemptKind" AS ENUM ('BUY', 'SELL');

-- AlterTable
ALTER TABLE "stock_buy_attempts" ADD COLUMN     "kind" "StockAttemptKind" NOT NULL DEFAULT 'BUY',
ADD COLUMN     "positionId" TEXT,
ADD COLUMN     "sponsored" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stock_positions" ADD COLUMN     "sellTxSig" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "stock_positions_sellTxSig_key" ON "stock_positions"("sellTxSig");
