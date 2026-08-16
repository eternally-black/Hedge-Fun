// Self-checks for embeddedEvmWallet + extractIdentity (DB-free part). Run: npx tsx scripts/test-identity.ts
import assert from "node:assert";
import { embeddedEvmWallet, extractIdentity } from "../src/lib/privy";
import type { User as PrivyUser } from "@privy-io/server-auth";

// ---- 1. embedded EVM among Solana external + twitter -> picks the ethereum+privy one, lowercased ----
const pu1 = {
  wallet: { address: "0xABC123", chainType: "ethereum", walletClientType: "privy" },
  linkedAccounts: [
    { type: "wallet", address: "PhantomSolAddr1", chainType: "solana", walletClientType: "phantom" },
    { type: "twitter_oauth", username: "alice" },
  ],
} as unknown as PrivyUser;
assert.strictEqual(embeddedEvmWallet(pu1), "0xabc123", "embedded EVM should be picked and lowercased");

// ---- 2. pu.wallet is Solana external, linkedAccounts has ethereum+privy -> picks the linked one (old bug) ----
const pu2 = {
  wallet: { address: "PhantomSolAddr2", chainType: "solana", walletClientType: "phantom" },
  linkedAccounts: [
    { type: "wallet", address: "0xDEF456", chainType: "ethereum", walletClientType: "privy" },
  ],
} as unknown as PrivyUser;
assert.strictEqual(embeddedEvmWallet(pu2), "0xdef456", "should pick linked embedded over external solana");

// ---- 3. only a Solana external anywhere -> null ----
const pu3 = {
  wallet: { address: "PhantomSolAddr3", chainType: "solana", walletClientType: "phantom" },
  linkedAccounts: [
    { type: "wallet", address: "PhantomSolAddr4", chainType: "solana", walletClientType: "phantom" },
  ],
} as unknown as PrivyUser;
assert.strictEqual(embeddedEvmWallet(pu3), null, "no embedded EVM -> null");

// ---- 4. checksummed embedded address -> lowercased output ----
const pu4 = {
  wallet: { address: "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12", chainType: "ethereum", walletClientType: "privy" },
  linkedAccounts: [],
} as unknown as PrivyUser;
assert.strictEqual(
  embeddedEvmWallet(pu4),
  "0xabcdef1234567890abcdef1234567890abcdef12",
  "checksummed address must be lowercased",
);

// ---- 5. no wallets at all -> null; extractIdentity still returns email/twitter correctly ----
const pu5 = {
  email: { address: "bob@example.com" },
  twitter: { username: "bob_x" },
  linkedAccounts: [
    { type: "email", address: "bob@example.com" },
    { type: "twitter_oauth", username: "bob_x" },
  ],
} as unknown as PrivyUser;
assert.strictEqual(embeddedEvmWallet(pu5), null, "no wallets -> null");
const id5 = extractIdentity(pu5);
assert.strictEqual(id5.email, "bob@example.com", "email extracted");
assert.strictEqual(id5.twitterHandle, "bob_x", "twitter extracted");
assert.strictEqual(id5.wallet, null, "wallet null");

console.log("OK: identity — embedded EVM wallet picked over externals, lowercased; null without one");
