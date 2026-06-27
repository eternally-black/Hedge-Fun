import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { topUp, type TopupKind } from "@/lib/topup";
import { TOPUP_POINTS_ENABLED } from "@/lib/config";
import type { TopupResponse } from "@/lib/api-types";

// Top up Cash by +$200. Body: { kind: "free" | "artifact" | "points" }.
//  - free: once ever, low-cash gate (re-derived server-side).      409 if used / not eligible.
//  - artifact: spend 1 artifact, no gate.                          402 if no artifact.
//  - points: DORMANT — 404 while TOPUP_POINTS_ENABLED is false (no client button exists).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { kind?: TopupKind } | null;
  const kind = body?.kind;
  if (kind !== "free" && kind !== "artifact" && kind !== "points") {
    return NextResponse.json({ error: "kind (free|artifact|points) required" }, { status: 400 });
  }
  // Dormant path stays invisible: a crafted points request 404s before touching anything.
  if (kind === "points" && !TOPUP_POINTS_ENABLED) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result: TopupResponse = await topUp(user.id, kind);
  if (!result.ok) {
    const code =
      result.reason === "no_artifact" || result.reason === "not_enough_points"
        ? 402
        : result.reason === "free_used" || result.reason === "free_not_eligible"
          ? 409
          : 404; // points_disabled
    return NextResponse.json(result, { status: code });
  }
  return NextResponse.json(result);
}
