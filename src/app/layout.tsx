import type { Metadata, Viewport } from "next";
import { Anton, Space_Mono, Hanken_Grotesk } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

// Design system fonts (from app design): Anton = display, Space Mono = numeric, Hanken = body.
const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const spaceMono = Space_Mono({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-num" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Hedge Fun",
  description: "Call it. Farm it. Swipe real prediction markets with virtual cash.",
};

// viewport-fit=cover so env(safe-area-inset-*) works on notched phones (the app goes fullscreen
// on mobile — see Frame in page.tsx). No maximumScale: pinch-zoom stays enabled (WCAG 1.4.4). The
// user-facing app has no <16px text inputs (auth is Privy's own UI), so dropping the old
// maximumScale=1 doesn't reintroduce iOS focus-zoom on the swipe flow.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${anton.variable} ${spaceMono.variable} ${hanken.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
