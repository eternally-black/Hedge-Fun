"use client";

// The real-money console lives at /real, outside the deck's single-page tab shell: a screen where a
// mis-tap spends real funds should not share navigation state with the swipe deck.
import { RealScreen } from "../screens/RealScreen";
import { useApi } from "../useApi";

export default function RealPage() {
  const api = useApi();

  return (
    <div style={{ position: "relative", minHeight: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
      <RealScreen api={api} />
    </div>
  );
}
