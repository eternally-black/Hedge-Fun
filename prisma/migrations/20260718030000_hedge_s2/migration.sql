-- Hedge S2 (life-event hedge, phase 2 workstream A2). Additive only: four nullable/defaulted
-- columns on market_meta (the sports/esports enrichment for the S2 pickers + matcher) and one
-- index on the s2Eligible gate. No existing column/flow changes -> S1 (crypto majors) and the
-- deck/swipe/settle pipeline are untouched. Hand-written to match schema.prisma; applied by
-- `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "market_meta" ADD COLUMN     "s2Eligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leagueSlug" TEXT,
ADD COLUMN     "leagueLabel" TEXT,
ADD COLUMN     "sportKind" TEXT;

-- CreateIndex
CREATE INDEX "market_meta_s2Eligible_idx" ON "market_meta"("s2Eligible");
