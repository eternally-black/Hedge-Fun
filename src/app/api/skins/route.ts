import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { runSkinAction } from "@/lib/skins-store";
import type { SkinActionResponse } from "@/lib/api-types";

// Map a rejection reason to its HTTP status (house style: 400 bad input, 402 insufficient, 409 conflict).
const STATUS = { unknown_skin: 400, already_owned: 409, not_owned: 409, no_artifact: 402 } as const;

// POST /api/skins — { action: "unlock" | "equip", skinId }. Thin: auth → validate → runSkinAction
// (the artifact-spend tx lives in src/lib/skins-store.ts, mirroring topup.ts / streak.ts).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { action?: "unlock" | "equip"; skinId?: string } | null;
  const action = body?.action;
  const skinId = body?.skinId;
  if ((action !== "unlock" && action !== "equip") || !skinId) {
    return NextResponse.json({ error: "action (unlock|equip) and skinId required" }, { status: 400 });
  }

  const result = await runSkinAction(user.id, action, skinId);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] });

  const res: SkinActionResponse = { owned: result.owned, equipped: result.equipped, artifacts: result.artifacts };
  return NextResponse.json(res);
}
