// Authenticated API client — the native twin of src/app/useApi.ts (web). Every call pulls a fresh
// Privy access token and sends it as `Authorization: Bearer` against the same backend; routes are
// consumed exactly as typed in lib/api-types.ts (the server stays the source of truth).
import { useCallback } from "react";
import { usePrivy } from "@privy-io/expo";
import { API_BASE } from "../lib/config";

// Carries the HTTP status so callers can branch on it (swipe 402/403/409 etc.), like the web's
// `err.status` convention.
export class ApiError extends Error {
  status: number;
  constructor(path: string, status: number) {
    super(`${path} -> ${status}`);
    this.status = status;
  }
}

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
      const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) throw new ApiError(path, res.status);
      return res.json();
    },
    [getAccessToken],
  );
}
