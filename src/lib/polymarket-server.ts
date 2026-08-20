// Server-side SecureClient assembly for relayer-driven workflows (wrap, approvals). D5 holds:
// the Signer stub CANNOT sign — every signature request must surface through the workflow relay
// and be answered by the device. The client authenticates with the CLIENT's builder API creds
// (server env, never shipped to a browser) plus the user's stored L2 CLOB creds (read/cancel
// auth — createSecureClient skips signature-based derivation when credentials are supplied;
// verified against SecureClientOptions in 0.6.0, Gate-0 exercises it live).
import { createSecureClient } from "@polymarket/client";
import { builderApiKey } from "@polymarket/client/node";
import type { PrismaClient, User } from "@prisma/client";
import { loadClobCreds } from "./clob-creds";

type ServerClient = Awaited<ReturnType<typeof createSecureClient>>;

function relaySigner(address: string) {
  const refuse = () => {
    throw new Error("device-signature required: this server holds no keys (D5) — drive it through the workflow relay");
  };
  return {
    getAddress: async () => address as never,
    signTypedData: async () => refuse() as never,
    signMessage: async () => refuse() as never,
    sendTransaction: async () => refuse() as never,
  };
}

// Construction does HTTP (credential validation; possibly a wallet-deployment check — and the SDK
// WOULD auto-deploy an undeployed wallet, which S2 owns, so this is only ever called with a
// persisted depositWalletAddress that S2 verified deployed). Cache per user for a few minutes so
// status polls don't pay 2 HTTP calls each (S4 review M1/M5).
const CLIENT_TTL_MS = 5 * 60 * 1000;
const clientCache = new Map<string, { at: number; client: ServerClient }>();

// Expired entries hold DECRYPTED CLOB credentials and were never removed — the map grew one entry
// per real-money user for the process lifetime. Swept on access; live entries are untouched.
function sweepClients(now: number): void {
  for (const [k, v] of clientCache) if (now - v.at >= CLIENT_TTL_MS) clientCache.delete(k);
}

// null = not configured yet (missing builder env, user creds, or wallet) — callers 503, never throw.
export async function serverSecureClient(prisma: PrismaClient, user: User): Promise<ServerClient | null> {
  const key = process.env.POLYMARKET_BUILDER_API_KEY;
  const secret = process.env.POLYMARKET_BUILDER_SECRET;
  const passphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE;
  if (!key || !secret || !passphrase) return null;
  if (!user.embeddedWalletAddress || !user.depositWalletAddress) return null;

  sweepClients(Date.now());
  const cached = clientCache.get(user.id);
  if (cached && Date.now() - cached.at < CLIENT_TTL_MS) return cached.client;

  let credentials;
  try {
    credentials = await loadClobCreds(prisma, user.id);
  } catch {
    return null; // DB hiccup reads as not-configured (503), never a raw 500 on a money route
  }
  if (!credentials) return null;

  try {
    const client = await createSecureClient({
      signer: relaySigner(user.embeddedWalletAddress),
      wallet: user.depositWalletAddress,
      credentials: credentials as never,
      apiKey: builderApiKey({ key, secret, passphrase }),
    } as never);
    clientCache.set(user.id, { at: Date.now(), client });
    return client;
  } catch {
    return null; // assembly failure = not configured / upstream down; workflow routes 503
  }
}
