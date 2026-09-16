-- The one-line "what is this company" card copy, plus the ISIN it is generated from. Additive and
-- nullable: every existing row keeps today's behaviour (no blurb line rendered) until the poller's
-- fillMissingBlurbs writes one, and a blurb may always be overwritten by hand.
-- AlterTable
ALTER TABLE "stock_assets" ADD COLUMN     "isin" TEXT,
ADD COLUMN     "blurb" TEXT;
