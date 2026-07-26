-- Depth-aware executable pricing (D10 Slice A). Additive only: seven NULLABLE columns on markets
-- (the CLOB token ids + per-side book-walked VWAP / max stake / book timestamp). No renames, no
-- drops, no backfill that could lose data or block rollback — existing rows keep NULLs, which the
-- serve paths read as "no book read" (TXODDS rows stay NULL forever: they have no CLOB book).
-- Hand-written to match schema.prisma; applied by `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "markets" ADD COLUMN     "yesTokenId" TEXT,
ADD COLUMN     "noTokenId" TEXT,
ADD COLUMN     "yesEffPriceBp" INTEGER,
ADD COLUMN     "noEffPriceBp" INTEGER,
ADD COLUMN     "yesMaxStakeCents" INTEGER,
ADD COLUMN     "noMaxStakeCents" INTEGER,
ADD COLUMN     "bookTsAt" TIMESTAMP(3);
