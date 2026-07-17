import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { recordSuggestionEvent } from "@/lib/hedge/telemetry";
import type { HedgeEventRequest, HedgeEventResponse } from "@/lib/api-types";

// Suggestion telemetry: impression / dismiss (accept is logged by /accept). Idempotent per event.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`hedge-event:${user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<HedgeEventRequest> | null;
  if (!body?.suggestionId || (body.event !== "impression" && body.event !== "dismiss")) {
    return NextResponse.json({ error: "suggestionId and event (impression|dismiss) required" }, { status: 400 });
  }

  const ok = await recordSuggestionEvent(user.id, body.suggestionId, body.event === "impression" ? "IMPRESSION" : "DISMISS");
  if (!ok) return NextResponse.json({ error: "suggestion_not_found" }, { status: 404 });

  const res: HedgeEventResponse = { ok: true };
  return NextResponse.json(res);
}
