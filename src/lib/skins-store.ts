import { runSerializable } from "./tx";
import { skinById } from "./skins";

export type SkinActionResult =
  | { ok: true; owned: string[]; equipped: string; artifacts: number }
  | { ok: false; reason: "unknown_skin" | "already_owned" | "not_owned" | "no_artifact" };

// Unlock spends `skin.cost` artifacts then equips; equip just switches (no cost, must already own).
// One Serializable tx (runSerializable, P2034-retry) so a concurrent unlock/topup/recover can't
// double-spend an artifact — the body re-reads the row, so a retry is idempotent. Same pattern as
// topUp()/recoverStreak(). The balance row is upserted (a brand-new user may not have one yet; the
// schema defaults give them the free Classic skin owned + equipped).
export async function runSkinAction(
  userId: string,
  action: "unlock" | "equip",
  skinId: string,
): Promise<SkinActionResult> {
  const skin = skinById(skinId);
  if (!skin) return { ok: false, reason: "unknown_skin" };

  return runSerializable<SkinActionResult>(async (tx) => {
    const cb = await tx.collectibleBalance.upsert({ where: { userId }, create: { userId }, update: {} });

    if (action === "equip") {
      if (!cb.ownedSkins.includes(skinId)) return { ok: false, reason: "not_owned" };
      const u =
        cb.equippedSkin === skinId
          ? cb
          : await tx.collectibleBalance.update({ where: { userId }, data: { equippedSkin: skinId } });
      return { ok: true, owned: u.ownedSkins, equipped: u.equippedSkin, artifacts: u.artifacts };
    }

    // unlock — spend artifacts, add to owned, equip instantly.
    if (cb.ownedSkins.includes(skinId)) return { ok: false, reason: "already_owned" };
    if (cb.artifacts < skin.cost) return { ok: false, reason: "no_artifact" };
    const u = await tx.collectibleBalance.update({
      where: { userId },
      data: { artifacts: { decrement: skin.cost }, ownedSkins: { push: skinId }, equippedSkin: skinId },
    });
    return { ok: true, owned: u.ownedSkins, equipped: u.equippedSkin, artifacts: u.artifacts };
  });
}
