-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('EMAIL', 'TWITTER');

-- CreateEnum
CREATE TYPE "BetSide" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('OPEN', 'CLOSED', 'RESOLVED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MarketOutcome" AS ENUM ('YES', 'NO', 'INVALID');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'SETTLED', 'VOID');

-- CreateEnum
CREATE TYPE "BetResult" AS ENUM ('PENDING', 'WIN', 'LOSS', 'PUSH');

-- CreateEnum
CREATE TYPE "PointsType" AS ENUM ('SWIPE', 'LOGIN', 'REFERRAL', 'STREAK_X2', 'TOPUP_SPEND');

-- CreateEnum
CREATE TYPE "StreakState" AS ENUM ('ACTIVE', 'BURNED_RECOVERABLE', 'LOST');

-- CreateEnum
CREATE TYPE "StreakEventType" AS ENUM ('QUALIFIED', 'BURNED', 'RECOVERED', 'LOST');

-- CreateEnum
CREATE TYPE "ReferralEventType" AS ENUM ('SIGNUP', 'QUALIFIED', 'INVITEE_BONUS', 'INVITER_ACCRUAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "privyId" TEXT NOT NULL,
    "authProvider" "AuthProvider" NOT NULL,
    "email" TEXT,
    "twitterHandle" TEXT,
    "embeddedWalletAddress" TEXT,
    "referralCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "signupIpHash" BYTEA,
    "signupUaHash" BYTEA,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "polymarketId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "category" TEXT,
    "imageUrl" TEXT,
    "outcomeYesLabel" TEXT NOT NULL DEFAULT 'Yes',
    "outcomeNoLabel" TEXT NOT NULL DEFAULT 'No',
    "yesPriceBp" INTEGER,
    "noPriceBp" INTEGER,
    "startsAt" TIMESTAMP(3),
    "resolutionDeadline" TIMESTAMP(3) NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedOutcome" "MarketOutcome",
    "resolvedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" "BetSide" NOT NULL,
    "stakeCents" INTEGER NOT NULL,
    "lockedPriceBp" INTEGER NOT NULL,
    "utcDay" VARCHAR(10) NOT NULL,
    "earnedPoint" BOOLEAN NOT NULL DEFAULT false,
    "settlementStatus" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "result" "BetResult" NOT NULL DEFAULT 'PENDING',
    "payoutCents" INTEGER,
    "pnlCents" INTEGER,
    "resolvedYes" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PointsType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "utcDay" VARCHAR(10) NOT NULL,
    "betId" TEXT,
    "referralId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_balances" (
    "userId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 20000,
    "lockedCents" INTEGER NOT NULL DEFAULT 0,
    "freeTopupUsed" BOOLEAN NOT NULL DEFAULT false,
    "topupCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_balances_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "collectible_balances" (
    "userId" TEXT NOT NULL,
    "shards" INTEGER NOT NULL DEFAULT 0,
    "artifacts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collectible_balances_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "shard_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "utcDay" VARCHAR(10) NOT NULL,
    "counted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shard_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_counters" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "utcDay" VARCHAR(10) NOT NULL,
    "swipeCount" INTEGER NOT NULL DEFAULT 0,
    "shardCount" INTEGER NOT NULL DEFAULT 0,
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "loginMarked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_marks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "utcDay" VARCHAR(10) NOT NULL,
    "bonusAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streaks" (
    "userId" TEXT NOT NULL,
    "currentLevel" INTEGER NOT NULL DEFAULT 0,
    "state" "StreakState" NOT NULL DEFAULT 'ACTIVE',
    "lastQualifiedDay" VARCHAR(10),
    "burnedAt" TIMESTAMP(3),
    "recoverableUntil" TIMESTAMP(3),
    "recoveredCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "streaks_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "streak_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "StreakEventType" NOT NULL,
    "utcDay" VARCHAR(10) NOT NULL,
    "levelBefore" INTEGER NOT NULL,
    "levelAfter" INTEGER NOT NULL,
    "artifactUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "streak_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt" TIMESTAMP(3),
    "inviteeBonusPaidAt" TIMESTAMP(3),

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_events" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "type" "ReferralEventType" NOT NULL,
    "sourcePointsLedgerId" TEXT,
    "sourceAmount" INTEGER,
    "rewardAmount" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_clicks" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ipHash" BYTEA NOT NULL,
    "uaHash" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_snapshots" (
    "id" TEXT NOT NULL,
    "utcDay" VARCHAR(10) NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "totalPoints" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_privyId_key" ON "users"("privyId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_twitterHandle_key" ON "users"("twitterHandle");

-- CreateIndex
CREATE UNIQUE INDEX "users_embeddedWalletAddress_key" ON "users"("embeddedWalletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "markets_polymarketId_key" ON "markets"("polymarketId");

-- CreateIndex
CREATE INDEX "markets_status_resolutionDeadline_idx" ON "markets"("status", "resolutionDeadline");

-- CreateIndex
CREATE INDEX "markets_status_resolvedAt_idx" ON "markets"("status", "resolvedAt");

-- CreateIndex
CREATE INDEX "bets_settlementStatus_idx" ON "bets"("settlementStatus");

-- CreateIndex
CREATE INDEX "bets_marketId_settlementStatus_idx" ON "bets"("marketId", "settlementStatus");

-- CreateIndex
CREATE INDEX "bets_userId_utcDay_idx" ON "bets"("userId", "utcDay");

-- CreateIndex
CREATE INDEX "bets_userId_settlementStatus_seenAt_idx" ON "bets"("userId", "settlementStatus", "seenAt");

-- CreateIndex
CREATE UNIQUE INDEX "bets_userId_marketId_key" ON "bets"("userId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "points_ledger_betId_key" ON "points_ledger"("betId");

-- CreateIndex
CREATE INDEX "points_ledger_userId_type_idx" ON "points_ledger"("userId", "type");

-- CreateIndex
CREATE INDEX "points_ledger_userId_utcDay_idx" ON "points_ledger"("userId", "utcDay");

-- CreateIndex
CREATE UNIQUE INDEX "shard_grants_betId_key" ON "shard_grants"("betId");

-- CreateIndex
CREATE INDEX "shard_grants_userId_utcDay_idx" ON "shard_grants"("userId", "utcDay");

-- CreateIndex
CREATE UNIQUE INDEX "daily_counters_userId_utcDay_key" ON "daily_counters"("userId", "utcDay");

-- CreateIndex
CREATE UNIQUE INDEX "login_marks_userId_utcDay_key" ON "login_marks"("userId", "utcDay");

-- CreateIndex
CREATE INDEX "streaks_state_idx" ON "streaks"("state");

-- CreateIndex
CREATE INDEX "streak_events_userId_createdAt_idx" ON "streak_events"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "streak_events_userId_utcDay_type_key" ON "streak_events"("userId", "utcDay", "type");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_inviteeId_key" ON "referrals"("inviteeId");

-- CreateIndex
CREATE INDEX "referrals_inviterId_idx" ON "referrals"("inviterId");

-- CreateIndex
CREATE UNIQUE INDEX "referral_events_sourcePointsLedgerId_key" ON "referral_events"("sourcePointsLedgerId");

-- CreateIndex
CREATE INDEX "referral_events_referralId_type_idx" ON "referral_events"("referralId", "type");

-- CreateIndex
CREATE INDEX "referral_clicks_ipHash_uaHash_createdAt_idx" ON "referral_clicks"("ipHash", "uaHash", "createdAt");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_utcDay_rank_idx" ON "leaderboard_snapshots"("utcDay", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_snapshots_utcDay_userId_key" ON "leaderboard_snapshots"("utcDay", "userId");

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_balances" ADD CONSTRAINT "virtual_balances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collectible_balances" ADD CONSTRAINT "collectible_balances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shard_grants" ADD CONSTRAINT "shard_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shard_grants" ADD CONSTRAINT "shard_grants_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_counters" ADD CONSTRAINT "daily_counters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_marks" ADD CONSTRAINT "login_marks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streak_events" ADD CONSTRAINT "streak_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

