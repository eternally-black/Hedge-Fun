-- Deposit ATTRIBUTION for the funding watcher (plan §2.5): Transfer logs instead of wallet-wide
-- balance deltas. `scanBlock` is the cursor (last finalized block already scanned, inclusive);
-- the in* columns accumulate what was actually transferred IN to the deposit wallet, so an
-- outflow (a trade, a withdrawal) can no longer mask a deposit or strand an attempt.
ALTER TABLE "funding_attempts" ADD COLUMN "scanBlock" BIGINT;
ALTER TABLE "funding_attempts" ADD COLUMN "inUsdceMicro" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "funding_attempts" ADD COLUMN "inPusdMicro" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "funding_attempts" ADD COLUMN "lastDepositTx" TEXT;
