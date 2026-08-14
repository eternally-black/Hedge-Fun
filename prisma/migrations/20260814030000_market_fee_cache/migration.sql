-- Per-market platform-fee cache + neg-risk flag (plan §2.6): refreshed at intent time, 24h TTL.
ALTER TABLE "markets" ADD COLUMN "feeRateBp" INTEGER;
ALTER TABLE "markets" ADD COLUMN "feeExpMilli" INTEGER;
ALTER TABLE "markets" ADD COLUMN "feeUpdatedAt" TIMESTAMP(3);
ALTER TABLE "markets" ADD COLUMN "negRisk" BOOLEAN;
