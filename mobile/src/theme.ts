// Neon Arcade palette — mirrors src/app/globals.css on the web client.
export const colors = {
  bg: "#0a0a0f",
  bg2: "#101019",
  panel: "#15151f",
  panel2: "#1c1c2a",
  line: "rgba(255,255,255,0.09)",
  text: "#f4f4fa",
  muted: "#8b8b9e",
  energy: "#ff3dcd", // points / brand pink
  yes: "#b6ff2e", // swipe-right (side A)
  no: "#ff3b4e", // swipe-left (side B)
  skip: "#4d9bff", // swipe-up
  gold: "#ffc24b", // shards / artifacts
} as const;

// hex + alpha suffix ("2e" ≈ 18%) like the web's color-mix usage.
export const withAlpha = (hex: string, alpha: string) => `${hex}${alpha}`;

// color-mix(in srgb, <hex> 55%, var(--line)) — the web's CircleBtn border. --line is white at 9%,
// so the mix is done premultiplied, exactly as CSS color-mix does with a translucent colour.
export function mixWithLine(hex: string, pct = 0.55): string {
  const lineA = 0.09;
  const a = pct + (1 - pct) * lineA;
  const ch = (i: number) => Math.round((pct * parseInt(hex.slice(i, i + 2), 16) + (1 - pct) * lineA * 255) / a);
  return `rgba(${ch(1)},${ch(3)},${ch(5)},${a.toFixed(4)})`;
}
