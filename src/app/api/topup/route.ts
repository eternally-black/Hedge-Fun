import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { topUp, type TopupKind } from "@/lib/topup";
import type { TopupResponse } from "@/lib/api-types";

// Top up Cash by +$200. Body: { kind: "free" | "artifact" }.
//  - free: once ever, low-cash gate (re-derived server-side).      409 if used / not eligible.
//  - artifact: spend 1 artifact, Cash < $50 gate (re-derived).     402 if no artifact, 409 if cash too high.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { kind?: TopupKind } | null;
  const kind = body?.kind;
  if (kind !== "free" && kind !== "artifact") {
    return NextResponse.json({ error: "kind (free|artifact) required" }, { status: 400 });
  }

  const result: TopupResponse = await topUp(user.id, kind);
  if (!result.ok) {
    const code =
      result.reason === "no_artifact"
        ? 402
        : 409; // free_used | free_not_eligible
    return NextResponse.json(result, { status: code });
  }
  return NextResponse.json(result);
}
