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
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      return res.json();
    },
    [getAccessToken],
  );
}
