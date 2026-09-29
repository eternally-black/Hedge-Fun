// Card-skins RENDER layer (native) — the phone's twin of src/app/skins.tsx. `SkinBackground` draws a
// skin's look (the web's CSS `background` + SVG overlay) with react-native-svg, then the readability
// SCRIM on top, filling its parent. The economic data (cost/name/blurb) is the shared catalog below —
// a copy of src/lib/skins.ts, which is pure data.
//
// Layering on a card: bg → overlay → SCRIM → content (the content is the caller's).
import { memo } from "react";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors } from "./theme";

export type SkinId = "classic" | "vapor" | "aurora" | "midas";
export interface Skin { id: SkinId; name: string; cost: number; accent: string; blurb: string }

// Mirrors src/lib/skins.ts SKINS (the server validates unlock costs against its own copy).
export const SKINS: readonly Skin[] = [
  { id: "classic", name: "Classic", cost: 0, accent: "#3d7bff", blurb: "Category tints, free for everyone." },
  { id: "vapor", name: "Vapor", cost: 2, accent: "#ff3dcd", blurb: "Synthwave horizon, endless run." },
  { id: "aurora", name: "Aurora", cost: 5, accent: "#7b8cff", blurb: "Iridescent silk waves over deep space." },
  { id: "midas", name: "Midas", cost: 7, accent: "#ffc24b", blurb: "Gilded isometric architecture in the dark." },
] as const;
export const skinById = (id: string): Skin | undefined => SKINS.find((s) => s.id === id);

const AURORA = require("../assets/skins/skin-aurora.webp");
const MIDAS = require("../assets/skins/skin-midas.webp");

// The web's `isFootball`: a soccer card gets the free pitch look. The server derives `league` at
// ingest, so the phone reads it directly. ponytail: the web also falls back to a question parser
// when league is missing; add it here if unlabelled soccer cards show up.
export const isFootballCard = (card: { league?: string | null }) => card.league === "Soccer";

// Every SVG here is drawn on the card's portrait box (300×470) and sliced to fill, like the web.
const VB = "0 0 300 470";

// Readability scrim between the (busy) background and the content: darkens the top chips and the
// bottom odds/controls, leaves the vivid middle.
function Scrim() {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={VB} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000" stopOpacity={0.34} />
          <Stop offset="0.22" stopColor="#000" stopOpacity={0} />
          <Stop offset="0.52" stopColor="#000" stopOpacity={0} />
          <Stop offset="0.78" stopColor="#000" stopOpacity={0.5} />
          <Stop offset="1" stopColor="#000" stopOpacity={0.72} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={300} height={470} fill="url(#scrim)" />
    </Svg>
  );
}

// Classic: the category tint — a colored bloom from the top-right over a panel2→panel wash (bgGrad).
function ClassicBg({ color }: { color: string }) {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={VB} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="wash" x1="0.1" y1="0" x2="0.9" y2="1">
          <Stop offset="0" stopColor={colors.panel2} />
          <Stop offset="1" stopColor={colors.panel} />
        </LinearGradient>
        <RadialGradient id="tint" cx="240" cy="0" rx="360" ry="376" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={color} stopOpacity={0.18} />
          <Stop offset="0.55" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={300} height={470} fill="url(#wash)" />
      <Rect x={0} y={0} width={300} height={470} fill="url(#tint)" />
    </Svg>
  );
}

// Classic on a soccer card: mowed grass (stripes + a green top bloom over deep green) + pitch lines.
const PITCH_LINE = "rgba(225,255,235,0.26)";
function FootballBg() {
  const stripes = [];
  for (let y = 0, i = 0; y < 470; y += 46, i++) {
    stripes.push(<Rect key={i} x={0} y={y} width={300} height={46} fill={i % 2 ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.045)"} />);
  }
  const s = { fill: "none", stroke: PITCH_LINE, strokeWidth: 2 } as const;
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={VB} preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id="grass" x1="0.1" y1="0" x2="0.9" y2="1">
          <Stop offset="0" stopColor="#123a26" />
          <Stop offset="1" stopColor="#0a2014" />
        </LinearGradient>
        <RadialGradient id="bloom" cx="150" cy="-38" rx="360" ry="282" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#2ee36a" stopOpacity={0.34} />
          <Stop offset="0.58" stopColor="#2ee36a" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={300} height={470} fill="url(#grass)" />
      <Rect x={0} y={0} width={300} height={470} fill="url(#bloom)" />
      <G>{stripes}</G>
      <Rect {...s} x={14} y={14} width={272} height={442} rx={3} />
      <Line {...s} x1={14} y1={235} x2={286} y2={235} />
      <Circle {...s} cx={150} cy={235} r={48} />
      <Circle cx={150} cy={235} r={2.6} fill={PITCH_LINE} />
      <Rect {...s} x={58} y={14} width={184} height={78} />
      <Rect {...s} x={106} y={14} width={88} height={32} />
      <Path {...s} d="M104 92 a 52 52 0 0 0 92 0" />
      <Circle cx={150} cy={66} r={2.6} fill={PITCH_LINE} />
      <Rect {...s} x={58} y={378} width={184} height={78} />
      <Rect {...s} x={106} y={424} width={88} height={32} />
      <Path {...s} d="M104 378 a 52 52 0 0 1 92 0" />
      <Circle cx={150} cy={404} r={2.6} fill={PITCH_LINE} />
      <Path {...s} d="M14 28 a 14 14 0 0 1 -0 -14" />
      <Path {...s} d="M286 14 a 14 14 0 0 1 0 14" />
      <Path {...s} d="M14 442 a 14 14 0 0 0 0 14" />
      <Path {...s} d="M286 456 a 14 14 0 0 0 0 -14" />
    </Svg>
  );
}

// Vapor: a synthwave sky (three glows over a violet fall-off) and the perspective grid — rays fanning
// from a vanishing point + horizontal lines spaced 1.34× wider each step toward the viewer.
function VaporBg() {
  const lines = [];
  for (let i = -6; i <= 6; i++) {
    lines.push(<Line key={`v${i}`} x1={150} y1={150} x2={150 + i * 72} y2={470} stroke="rgba(70,210,255,0.34)" strokeWidth={1.4} />);
  }
  let y = 150;
  let step = 7;
  for (let i = 0; i < 16; i++) {
    y += step;
    step *= 1.34;
    if (y > 470) break;
    lines.push(<Line key={`h${i}`} x1={0} y1={y} x2={300} y2={y} stroke="rgba(255,90,210,0.42)" strokeWidth={1.3} />);
  }
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={VB} preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#2a0f3f" />
          <Stop offset="0.44" stopColor="#1a0a2e" />
          <Stop offset="1" stopColor="#08040f" />
        </LinearGradient>
        <RadialGradient id="cyan" cx="150" cy="66" rx="360" ry="329" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#36e0ff" stopOpacity={0.32} />
          <Stop offset="0.55" stopColor="#36e0ff" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="pink" cx="150" cy="75" rx="270" ry="235" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#ff3dcd" stopOpacity={0.5} />
          <Stop offset="0.6" stopColor="#ff3dcd" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="sun" cx="150" cy="42" rx="174" ry="150" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#ffc44b" stopOpacity={0.55} />
          <Stop offset="0.6" stopColor="#ffc44b" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={300} height={470} fill="url(#sky)" />
      <Rect x={0} y={0} width={300} height={470} fill="url(#cyan)" />
      <Rect x={0} y={0} width={300} height={470} fill="url(#pink)" />
      <Rect x={0} y={0} width={300} height={470} fill="url(#sun)" />
      <G>{lines}</G>
    </Svg>
  );
}

// The single source of truth for how a skin LOOKS on the phone. A premium skin applies to every card,
// football included; Classic tints by category and turns soccer cards into a pitch.
export const SkinBackground = memo(function SkinBackground({ skinId, categoryColor, isFootball, scrim = true }: {
  skinId: string;
  categoryColor: string;
  isFootball: boolean;
  scrim?: boolean;
}) {
  let bg;
  switch (skinId) {
    case "vapor": bg = <VaporBg />; break;
    case "aurora": bg = <Image source={AURORA} style={[StyleSheet.absoluteFill, { width: "100%", height: "100%", backgroundColor: "#05060c" }]} resizeMode="cover" />; break;
    case "midas": bg = <Image source={MIDAS} style={[StyleSheet.absoluteFill, { width: "100%", height: "100%", backgroundColor: "#070501" }]} resizeMode="cover" />; break;
    default: bg = isFootball ? <FootballBg /> : <ClassicBg color={categoryColor} />;
  }
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {bg}
      {scrim ? <Scrim /> : null}
    </View>
  );
});
