// Shared opaque keyset cursor for every "newest first" list (feed, history, results). The cursor
// is "<ISO timestamp>|<id>" base64url-encoded so the client treats it as an opaque string — it
// never parses it, only passes it back as ?cursor=. Decoding is tolerant: malformed input returns
// null (treated as "no cursor"), never throws.
export function encodeKeysetCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeKeysetCursor(raw: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const at = new Date(iso!);
    if (!id || Number.isNaN(at.getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}
