-- S7 remainder: redeem + withdraw ride the same relay engine as wrap/approvals.
-- PG12+ allows ADD VALUE inside a transaction as long as the value is not used in the same tx.
ALTER TYPE "WalletOpKind" ADD VALUE IF NOT EXISTS 'REDEEM';
ALTER TYPE "WalletOpKind" ADD VALUE IF NOT EXISTS 'WITHDRAW';
