// Credential-free public client; secure clients exist ONLY in the browser (D5). This singleton is
// used by server routes that need read-only chain checks (e.g. /api/real/wallet verifying a
// deployed Deposit Wallet). No credentials required — Polymarket's public RPC is open.
import { createPublicClient } from "@polymarket/client";

export const polymarketPublic = createPublicClient();
