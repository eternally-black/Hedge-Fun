// Authenticated API client — the native twin of src/app/useApi.ts (web). Every call pulls a fresh
// Privy access token and sends it as `Authorization: Bearer` against the same backend; routes are
// consumed exactly as typed in lib/api-types.ts (the server stays the source of truth).
import { useCallback } from "react";
import { usePrivy } from "@privy-io/expo";
import { API_BASE } from "../lib/config";
import { FLAVOR } from "./platform/flavor";

// Carries the HTTP status so callers can branch on it (swipe 402/403/409 etc.), like the web's
// `err.status` convention.
export class ApiError extends Error {
  status: number;
  // Typed errors carry a payload the caller must act on — 409 price_moved ships the fresh executable
  // price so the deck can restore the card at the honest number instead of just losing it.
  body: unknown;
  constructor(path: string, status: number, body?: unknown) {
    super(`${path} -> ${status}`);
    this.status = status;
    this.body = body;
  }
}

// The body of a 409 price_moved, when that is what came back. Narrow accessor so screens don't
// hand-cast `unknown` at every call site.
export const priceMovedBp = (e: unknown): number | undefined => {
  if (!(e instanceof ApiError) || e.status !== 409) return undefined;
  const b = e.body as { error?: string; freshPriceBp?: number } | undefined;
  return b?.error === "price_moved" && typeof b.freshPriceBp === "number" ? b.freshPriceBp : undefined;
};

export type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export const statusOf = (e: unknown): number | undefined =>
  e instanceof ApiError ? e.status : undefined;

// Returns a fetch wrapper that attaches the Privy access token as a Bearer header.
// Paths are API-relative ("/api/me"); the base comes from EXPO_PUBLIC_API_BASE.
export function useApi(): Api {
  const { getAccessToken } = usePrivy();

  return useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getAccessToken();
      // F10: bound every request so a hung socket on flaky cellular (captive portal, stalled TLS) can't
      // leave a form spinning forever. Abort at 15s; the thrown AbortError carries no ApiError.status,
      // so callers fall through to their generic retry-toast path exactly like any other failure.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(`${API_BASE}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            ...(init?.headers ?? {}),
            "content-type": "application/json",
            // Names the build to the server: money routes accept "no Origin + this header" as the
            // native client (src/lib/real.ts sameOrigin), and /api/me can shape surfaces per flavor.
            "x-hf-client": FLAVOR,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
        // Parse the error body before throwing, but never let a non-JSON body mask the real failure.
        if (!res.ok) throw new ApiError(path, res.status, await res.json().catch(() => undefined));
        return await res.json();
      } finally {
        clearTimeout(timeout);
      }
    },
    [getAccessToken],
  );
}
