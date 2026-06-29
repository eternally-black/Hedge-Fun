-- AlterTable
ALTER TABLE "collectible_balances" ADD COLUMN     "equippedSkin" TEXT NOT NULL DEFAULT 'classic',
ADD COLUMN     "ownedSkins" TEXT[] DEFAULT ARRAY['classic']::TEXT[];
