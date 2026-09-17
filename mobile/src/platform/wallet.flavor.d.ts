// The flavor's WALLET PORT — the one place the two builds differ on money. Metro resolves an import
// of "./wallet.flavor" to wallet.<flavor>.ts (mobile/metro.config.js); this file is the contract
// both implementations satisfy (each ends with a `typeof import("./wallet.flavor")` check).
//
//   seeker — Mobile Wallet Adapter: the Seeker's Seed Vault wallet (or Phantom etc.) proves and signs.
//   play   — nothing: the Play build renders the paper economy only (docs/shipaton.md §1).
//
// The client never builds a transaction on any platform. The server builds the swap bytes
// (/api/stocks/real/tx), the wallet signs them here, the server co-signs and sends (/real/submit).
import type { MwaLinkNonceResponse, MwaLinkRequest } from "@contract/api-types";

/** Can this build talk to a wallet at all? false = hide every real-money surface. */
export const available: boolean;

/**
 * Authorize a wallet and Sign In With Solana using the server-issued input (GET /api/link/mwa).
 * Returns the wallet's raw `sign_in_result` — POST it verbatim to /api/link/mwa, which verifies
 * it and answers with the base58 address to store as the trading wallet.
 */
export function connect(siws: MwaLinkNonceResponse): Promise<MwaLinkRequest>;

/** Sign a server-built transaction (base64 wire bytes) → user-signed bytes (base64). */
export function signTransaction(txBase64: string): Promise<string>;

/** Forget the cached wallet authorization (the server-side link is untouched). */
export function disconnect(): Promise<void>;

/** The user dismissed the wallet (declined, closed the sheet, did not sign): silent, no toast. */
export function isUserCancel(e: unknown): boolean;

/** No compatible wallet app is installed on this phone. */
export function isNoWallet(e: unknown): boolean;
