// Card-skins catalog — the single source of truth for skin ECONOMIC + LABEL data, shared by the
// unlock route (server, for cost validation) and the client shop/preview. Pure data (no prisma, no
// JSX) so it's safe to import from either side. The VISUAL look of each skin lives in the client-
// only renderer (src/app/skins.tsx skinStyle); this file just names the skins and prices them.
//
// Skins are a tiny fixed set, so the catalog is CODE, not a DB table. Ownership persists per-user as
// two columns on CollectibleBalance (ownedSkins / equippedSkin); everyone starts owning "classic".

export type SkinId = "classic" | "vapor" | "aurora" | "midas";

export interface Skin {
  id: SkinId;
  name: string;
  cost: number; // artifacts to unlock; 0 = free (classic)
  accent: string; // swatch accent used when previewing the skin off-deck (no live category color)
  blurb: string;
}

export const SKINS: readonly Skin[] = [
  { id: "classic", name: "Classic", cost: 0, accent: "#3d7bff", blurb: "Category tints, free for everyone." },
  { id: "vapor", name: "Vapor", cost: 2, accent: "#ff3dcd", blurb: "Synthwave horizon, endless run." },
  { id: "aurora", name: "Aurora", cost: 5, accent: "#7b8cff", blurb: "Iridescent silk waves over deep space." },
  { id: "midas", name: "Midas", cost: 7, accent: "#ffc24b", blurb: "Gilded isometric architecture in the dark." },
] as const;

export const skinById = (id: string): Skin | undefined => SKINS.find((s) => s.id === id);

// Cost of a skin, or undefined for an unknown id (the route treats undefined as a 400 — validates id).
export const skinCost = (id: string): number | undefined => skinById(id)?.cost;
