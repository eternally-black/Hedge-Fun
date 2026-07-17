// Referral code capture — the native counterpart of the web's hf_ref cookie/localStorage mirror
// (src/app/page.tsx readRef). The code is stored on device until the server binds it.
import * as SecureStore from "expo-secure-store";

const KEY = "hf_ref";

export async function readRefCode(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function saveRefCode(code: string): Promise<void> {
  const trimmed = code.trim();
  if (!trimmed) return;
  try {
    await SecureStore.setItemAsync(KEY, trimmed);
  } catch {
    /* storage unavailable — the in-session flow still works */
  }
}

// Called once the server confirmed the bind (capture-ref returned captured:true) — no need to
// keep resending. Resending would still be idempotent server-side, this just keeps storage tidy.
export async function clearRefCode(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    /* no-op */
  }
}

// TODO(client-owned): Play Install Referrer — the deferred-deep-link path for organic installs
// (docs/share-and-android.md §4). Once the Play Store listing exists, invite links should point at
// the store URL with `&referrer=CODE`; on FIRST OPEN the app reads that referrer string via the
// `play-install-referrer` library (or `react-native-play-install-referrer`) and, if it carries a
// code, calls saveRefCode(code) here — before boot's capture-ref POST. Blocked on the store
// listing, which is client-owned. Manual code entry on the login screen is the baseline until then.
export async function readInstallReferrerCode(): Promise<string | null> {
  return null;
}
