"use client";

import { useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";

// Returns a fetch wrapper that attaches the Privy access token as a Bearer header,
// so our API routes can verify the caller. Reused by every client call.
export function useApi() {
  const { getAccessToken } = usePrivy();

  return useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getAccessToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) {
        const err = new Error(`${path} -> ${res.status}`) as Error & {
          status?: number;
          body?: unknown;
        };
        err.status = res.status; // let callers branch on it (e.g. swipe 409 = already bet)
        // Typed errors carry a payload the caller needs to act on — 409 price_moved ships the fresh
        // executable price so the deck can re-render the card honestly instead of just dropping it.
        // Parsing must never mask the original failure, so a non-JSON body just leaves `body` undefined.
        err.body = await res.json().catch(() => undefined);
        throw err;
      }
      return res.json();
    },
    [getAccessToken],
  );
}
