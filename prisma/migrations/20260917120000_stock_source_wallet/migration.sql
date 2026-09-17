-- A stock lot can now come from the user's own wallet: xStocks that were already there when the
-- wallet was connected are adopted as lots (source WALLET). Additive enum value; nothing rewritten.
ALTER TYPE "BetSource" ADD VALUE 'WALLET';
