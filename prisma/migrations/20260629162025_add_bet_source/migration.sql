-- CreateEnum
CREATE TYPE "BetSource" AS ENUM ('DECK', 'FEED');

-- AlterTable
ALTER TABLE "bets" ADD COLUMN     "source" "BetSource" NOT NULL DEFAULT 'DECK';
