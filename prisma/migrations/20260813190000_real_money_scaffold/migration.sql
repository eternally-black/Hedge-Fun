-- CreateEnum
CREATE TYPE "BetMode" AS ENUM ('PAPER', 'REAL');

-- CreateEnum
CREATE TYPE "OrderDir" AS ENUM ('ENTRY', 'EXIT');

-- CreateEnum
CREATE TYPE "OrderAttemptState" AS ENUM ('ISSUED', 'SIGNED', 'SUBMITTING', 'POSTED', 'FILLED', 'PARTIAL', 'KILLED', 'FAILED');

-- CreateEnum
CREATE TYPE "WalletOpKind" AS ENUM ('DEPLOY', 'APPROVALS', 'WRAP');

-- CreateEnum
CREATE TYPE "WalletWorkflowState" AS ENUM ('PENDING_SIGNATURE', 'SUBMITTING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "RelayerTxStatus" AS ENUM ('SUBMITTING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "FundingState" AS ENUM ('AWAITING', 'DETECTED', 'FUNDED');

-- DropIndex
DROP INDEX "bets_userId_marketId_key";

-- AlterTable
ALTER TABLE "bets" ADD COLUMN     "closeFeeMicro" BIGINT,
ADD COLUMN     "closedSharesMicro" BIGINT,
ADD COLUMN     "feeMicro" BIGINT,
ADD COLUMN     "filledSharesMicro" BIGINT,
ADD COLUMN     "mode" "BetMode" NOT NULL DEFAULT 'PAPER',
ADD COLUMN     "proceedsMicro" BIGINT,
ADD COLUMN     "realizedPnlMicro" BIGINT,
ADD COLUMN     "spendMicro" BIGINT,
ADD COLUMN     "vwapBp" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "depositWalletAddress" TEXT,
ADD COLUMN     "realConsentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "order_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "betId" TEXT,
    "dir" "OrderDir" NOT NULL,
    "side" "BetSide" NOT NULL,
    "tokenId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "approvedParams" JSONB NOT NULL,
    "allInCapMicro" BIGINT NOT NULL,
    "maxPriceBp" INTEGER NOT NULL,
    "state" "OrderAttemptState" NOT NULL DEFAULT 'ISSUED',
    "signedOrderHash" TEXT,
    "externalOrderId" TEXT,
    "postResponse" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "externalFillId" TEXT NOT NULL,
    "sharesMicro" BIGINT NOT NULL,
    "amountMicro" BIGINT NOT NULL,
    "feeMicro" BIGINT NOT NULL,
    "priceBp" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_workflows" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "WalletOpKind" NOT NULL,
    "state" "WalletWorkflowState" NOT NULL DEFAULT 'PENDING_SIGNATURE',
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "inputs" JSONB NOT NULL,
    "pendingRequest" JSONB,
    "pendingRequestHash" TEXT,
    "txHash" TEXT,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "FundingState" NOT NULL DEFAULT 'AWAITING',
    "baselineUsdceMicro" BIGINT NOT NULL DEFAULT 0,
    "baselinePusdMicro" BIGINT NOT NULL DEFAULT 0,
    "latestUsdceMicro" BIGINT NOT NULL DEFAULT 0,
    "latestPusdMicro" BIGINT NOT NULL DEFAULT 0,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "fundedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "funding_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relayer_txs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "WalletOpKind" NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "txHash" TEXT,
    "status" "RelayerTxStatus" NOT NULL DEFAULT 'SUBMITTING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relayer_txs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clob_credentials" (
    "userId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clob_credentials_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_attempts_idempotencyKey_key" ON "order_attempts"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "order_attempts_signedOrderHash_key" ON "order_attempts"("signedOrderHash");

-- CreateIndex
CREATE UNIQUE INDEX "order_attempts_externalOrderId_key" ON "order_attempts"("externalOrderId");

-- CreateIndex
CREATE INDEX "order_attempts_userId_marketId_state_idx" ON "order_attempts"("userId", "marketId", "state");

-- CreateIndex
CREATE INDEX "order_attempts_state_updatedAt_idx" ON "order_attempts"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "fills_externalFillId_key" ON "fills"("externalFillId");

-- CreateIndex
CREATE INDEX "fills_attemptId_idx" ON "fills"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_workflows_userId_kind_key" ON "wallet_workflows"("userId", "kind");

-- CreateIndex
CREATE INDEX "funding_attempts_state_lastCheckedAt_idx" ON "funding_attempts"("state", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "funding_attempts_userId_declaredAt_idx" ON "funding_attempts"("userId", "declaredAt");

-- CreateIndex
CREATE INDEX "relayer_txs_createdAt_idx" ON "relayer_txs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "relayer_txs_userId_kind_workflowKey_key" ON "relayer_txs"("userId", "kind", "workflowKey");

-- CreateIndex
CREATE UNIQUE INDEX "bets_userId_marketId_mode_key" ON "bets"("userId", "marketId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "users_depositWalletAddress_key" ON "users"("depositWalletAddress");

-- AddForeignKey
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "order_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_workflows" ADD CONSTRAINT "wallet_workflows_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_attempts" ADD CONSTRAINT "funding_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relayer_txs" ADD CONSTRAINT "relayer_txs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clob_credentials" ADD CONSTRAINT "clob_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================ advisor-review hardening (K3 + Sol, step-1 review)

-- WalletWorkflow.answers — ordered replay transcript; without it rebuild-and-replay (§2.4) is unimplementable.
ALTER TABLE "wallet_workflows" ADD COLUMN "answers" JSONB NOT NULL DEFAULT '[]';

-- RelayerTx.attempts — retry spend stays countable while retries collapse into one row per op (§6).
ALTER TABLE "relayer_txs" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;

-- Single in-flight order attempt per (user, market): PARTIAL unique over non-terminal states (§2.1).
CREATE UNIQUE INDEX "order_attempts_one_inflight" ON "order_attempts"("userId", "marketId")
WHERE "state" IN ('ISSUED', 'SIGNED', 'SUBMITTING', 'POSTED');

-- One ACTIVE funding attempt per user — duplicate declarations must not spawn competing watcher/wrap workflows.
CREATE UNIQUE INDEX "funding_attempts_one_active" ON "funding_attempts"("userId")
WHERE "state" <> 'FUNDED';

-- Execution ledger must never silently detach from its position aggregate.
ALTER TABLE "order_attempts" DROP CONSTRAINT "order_attempts_betId_fkey";
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_betId_fkey"
  FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money-ledger sanity CHECKs: an app defect must not be able to persist an impossible ledger.
ALTER TABLE "bets" ADD CONSTRAINT "bets_real_fields_nonneg" CHECK (
  COALESCE("filledSharesMicro", 0) >= 0 AND COALESCE("spendMicro", 0) >= 0 AND COALESCE("feeMicro", 0) >= 0
  AND COALESCE("closedSharesMicro", 0) >= 0 AND COALESCE("proceedsMicro", 0) >= 0 AND COALESCE("closeFeeMicro", 0) >= 0
);
ALTER TABLE "bets" ADD CONSTRAINT "bets_closed_le_filled" CHECK (
  COALESCE("closedSharesMicro", 0) <= COALESCE("filledSharesMicro", 0)
);
ALTER TABLE "bets" ADD CONSTRAINT "bets_paper_no_real_fields" CHECK (
  "mode" = 'REAL' OR (
    "filledSharesMicro" IS NULL AND "spendMicro" IS NULL AND "feeMicro" IS NULL AND "vwapBp" IS NULL
    AND "closedSharesMicro" IS NULL AND "proceedsMicro" IS NULL AND "closeFeeMicro" IS NULL AND "realizedPnlMicro" IS NULL
  )
);
ALTER TABLE "fills" ADD CONSTRAINT "fills_sane" CHECK (
  "sharesMicro" >= 0 AND "amountMicro" >= 0 AND "feeMicro" >= 0 AND "priceBp" BETWEEN 0 AND 10000
);
