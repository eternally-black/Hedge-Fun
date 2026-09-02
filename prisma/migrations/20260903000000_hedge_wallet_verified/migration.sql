-- HedgeWallet.verifiedAt: set when the address is one of the user's Privy-LINKED Solana wallets
-- (the wallet signed Privy's challenge). A pasted address only proves the user typed it once; only a
-- verified wallet may be offered as a withdraw destination (/api/real/withdraw GET connected.solana).
ALTER TABLE "hedge_wallets" ADD COLUMN "verifiedAt" TIMESTAMP(3);
