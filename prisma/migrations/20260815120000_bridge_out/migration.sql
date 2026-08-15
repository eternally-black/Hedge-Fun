-- BRIDGE_OUT: the money-out leg — a pUSD transfer to a single-purpose bridge address. Distinct from
-- WITHDRAW, which is the collateral return that only turns positions back into pUSD in the wallet.
-- PG12+ allows ADD VALUE inside a transaction as long as the value is not used in the same tx.
ALTER TYPE "WalletOpKind" ADD VALUE IF NOT EXISTS 'BRIDGE_OUT';
