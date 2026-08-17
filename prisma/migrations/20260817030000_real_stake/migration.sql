-- Per-user real-money stake, in cents.
--
-- Default 100 ($1) rather than the paper STAKE_CENTS ($10): this is somebody's own money, and $1 is
-- what Polymarket's own ticket accepts as a market buy at any price. The paper stake stays $10 --
-- the two numbers are deliberately unrelated, one is a game rule and the other is a spend.
ALTER TABLE "users" ADD COLUMN "realStakeCents" INTEGER NOT NULL DEFAULT 100;
