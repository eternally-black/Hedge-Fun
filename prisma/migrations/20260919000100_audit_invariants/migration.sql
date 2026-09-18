-- Durable keyset checkpoints for bounded, fair background sweeps.
CREATE TABLE "sweep_cursors" (
  "name" TEXT NOT NULL,
  "afterCreatedAt" TIMESTAMP(3),
  "afterId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sweep_cursors_pkey" PRIMARY KEY ("name")
);

-- Exact signed bytes are persisted before broadcast; landed slots fence later wallet snapshots.
ALTER TABLE "stock_buy_attempts"
  ADD COLUMN "signedTx" TEXT,
  ADD COLUMN "signedTxHash" TEXT,
  ADD COLUMN "confirmedSlot" BIGINT,
  ADD COLUMN "manualReviewReason" TEXT;

CREATE TABLE "stock_wallet_states" (
  "userId" TEXT NOT NULL,
  "payer" TEXT NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 0,
  "lastAcceptedSlot" BIGINT,
  "latestConfirmedReceiptSlot" BIGINT,
  "lastCheckedAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_wallet_states_pkey" PRIMARY KEY ("userId", "payer"),
  CONSTRAINT "stock_wallet_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "stock_wallet_states_lastCheckedAt_idx" ON "stock_wallet_states"("lastCheckedAt");
CREATE INDEX "stock_wallet_states_leaseUntil_idx" ON "stock_wallet_states"("leaseUntil");
CREATE INDEX "stock_wallet_states_payer_idx" ON "stock_wallet_states"("payer");

-- Existing open lots become refresh candidates without claiming a slot they were never observed at.
INSERT INTO "stock_wallet_states" ("userId", "payer", "generation", "createdAt", "updatedAt")
SELECT DISTINCT "userId", "payer", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "stock_positions"
WHERE "mode" = 'REAL' AND "closedAt" IS NULL AND "payer" IS NOT NULL
ON CONFLICT ("userId", "payer") DO NOTHING;
