// Card-skins RENDER layer (client-only). `skinStyle` is the single source of truth for how a skin
// LOOKS: it maps a skin id (+ the card's live category color, + whether the card is a soccer match)
// to a CSS `background` string and an optional SVG overlay. Ported from the prototype
// (app design/Hedge Fun.dc.html). The economic data (cost/name/blurb) lives in src/lib/skins.ts.
//
// Layering on a card (see DeckCard CardFace): bg → overlay → SCRIM → content. The SCRIM keeps the
// top chips and bottom odds/controls legible over busy art; it applies to every skin.
"use client";

import type { ReactNode } from "react";
import { bgGrad } from "./ui";

// Readability scrim — fixed gradient between the (busy) background/overlay and the card content.
// Darkens the top (category/countdown chips) and bottom (odds bar, stake/win, swipe buttons) while
// leaving the vivid middle. Keep this — backgrounds are now busy and text/controls must stay readable.
export const SCRIM =
  "linear-gradient(180deg, rgba(0,0,0,.34) 0%, transparent 22%, transparent 52%, rgba(0,0,0,.5) 78%, rgba(0,0,0,.72) 100%)";

// ── Static SVG overlays — hoisted to module constants (rendering-hoist-jsx). They never change, so
//    skinStyle returns the SAME element instance every call; no re-creation per render. ────────────

const PITCH_LINE = "rgba(225,255,235,0.26)";
const stroke = { fill: "none", stroke: PITCH_LINE, strokeWidth: 2, vectorEffect: "non-scaling-stroke" } as const;
const Dot = ({ cx, cy }: { cx: number; cy: number }) => <circle cx={cx} cy={cy} r={2.6} fill={PITCH_LINE} />;

// Soccer pitch markings (free Classic look on soccer cards). viewBox is the card's portrait ratio;
// `slice` crops to fill. Strokes use vectorEffect so line weight stays constant at any scale.
const PITCH: ReactNode = (
  <svg viewBox="0 0 300 470" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
    <rect {...stroke} x={14} y={14} width={272} height={442} rx={3} />
    <line {...stroke} x1={14} y1={235} x2={286} y2={235} />
    <circle {...stroke} cx={150} cy={235} r={48} />
    <Dot cx={150} cy={235} />
    {/* top half */}
    <rect {...stroke} x={58} y={14} width={184} height={78} />
    <rect {...stroke} x={106} y={14} width={88} height={32} />
    <path {...stroke} d="M104 92 a 52 52 0 0 0 92 0" />
    <Dot cx={150} cy={66} />
    {/* bottom half */}
    <rect {...stroke} x={58} y={378} width={184} height={78} />
    <rect {...stroke} x={106} y={424} width={88} height={32} />
    <path {...stroke} d="M104 378 a 52 52 0 0 1 92 0" />
    <Dot cx={150} cy={404} />
    {/* corner arcs */}
    <path {...stroke} d="M14 28 a 14 14 0 0 1 -0 -14" />
    <path {...stroke} d="M286 14 a 14 14 0 0 1 0 14" />
    <path {...stroke} d="M14 442 a 14 14 0 0 0 0 14" />
    <path {...stroke} d="M286 456 a 14 14 0 0 0 0 -14" />
  </svg>
);

// Vapor's synthwave perspective grid: vertical rays fanning from a vanishing point + horizontal
// lines whose spacing grows toward the bottom (1.34× each step) for the receding-floor illusion.
function buildGrid(): ReactNode {
  const cH = "rgba(255,90,210,0.42)";
  const cV = "rgba(70,210,255,0.34)";
  const lines: ReactNode[] = [];
  for (let i = -6; i <= 6; i++) {
    lines.push(
      <line key={`v${i}`} x1={150} y1={150} x2={150 + i * 72} y2={470} stroke={cV} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />,
    );
  }
  let y = 150;
  let step = 7;
  for (let i = 0; i < 16; i++) {
    y += step;
    step *= 1.34;
    if (y > 470) break;
    lines.push(
      <line key={`h${i}`} x1={0} y1={y} x2={300} y2={y} stroke={cH} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />,
    );
  }
  return (
    <svg viewBox="0 0 300 470" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
      {lines}
    </svg>
  );
}
const GRID: ReactNode = buildGrid();

// Football-pitch grass: mowed stripes + a top green bloom over a deep-green base.
const GRASS =
  "repeating-linear-gradient(178deg, rgba(255,255,255,0.045) 0 46px, rgba(0,0,0,0.07) 46px 92px), radial-gradient(120% 60% at 50% -8%, rgba(46,227,106,0.34), transparent 58%), linear-gradient(170deg, #123a26, #0a2014)";

export interface SkinLook {
  bg: string; // CSS `background` — gradient string OR an image url()
  overlay: ReactNode | null; // SVG layer above bg, below the scrim
}

// The single source of truth for a skin's look. `categoryColor` tints the free Classic look per
// category; `isFootball` swaps Classic for the auto pitch+grass. A premium skin (vapor/aurora/midas)
// overrides everything — it applies to ALL cards, football included.
export function skinStyle(id: string, categoryColor: string, isFootball: boolean): SkinLook {
  switch (id) {
    case "vapor":
      return {
        bg: "radial-gradient(90% 50% at 50% 16%, rgba(255,61,205,.5), transparent 60%), radial-gradient(58% 32% at 50% 9%, rgba(255,196,75,.55), transparent 60%), radial-gradient(120% 70% at 50% 14%, rgba(54,224,255,.32), transparent 55%), linear-gradient(180deg,#2a0f3f 0%, #1a0a2e 44%, #08040f 100%)",
        overlay: GRID,
      };
    case "aurora":
      return { bg: "#05060c center/cover no-repeat url('/assets/skin-aurora.webp')", overlay: null };
    case "midas":
      return { bg: "#070501 center/cover no-repeat url('/assets/skin-midas.webp')", overlay: null };
    default:
      // Classic: soccer cards get the auto pitch; everything else keeps the current category tint
      // (bgGrad) so existing non-football cards look identical to before skins existed.
      if (isFootball) return { bg: GRASS, overlay: PITCH };
      return { bg: bgGrad(categoryColor), overlay: null };
  }
}
