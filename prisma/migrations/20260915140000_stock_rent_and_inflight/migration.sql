-- Two facts the real stock path could not express. Additive only, no backfill: every existing row
-- keeps today's behaviour (no stored bytes, rent treated as the user's own).
--   unsignedTx      — a retried sponsored SELL re-serves the SAME transaction instead of building a
--                     second one for the same lot (only one of the two could ever be booked).
--   rentFromSponsor — who paid the token account's rent, so the sell that closes it sends the rent
--                     back to the right address (sponsor for a sponsored buy, otherwise the user).
-- AlterTable
ALTER TABLE "stock_buy_attempts" ADD COLUMN     "unsignedTx" TEXT,
ADD COLUMN     "rentFromSponsor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stock_positions" ADD COLUMN     "rentFromSponsor" BOOLEAN NOT NULL DEFAULT false;
