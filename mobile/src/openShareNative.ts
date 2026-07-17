// Native share opener — implemented EXACTLY per docs/share-and-android.md §3.
// Deep-link into the X/TG app first (lands in the real composer), then the web intent in a
// Custom Tab, then the OS share sheet. canOpenURL for the custom schemes needs the Android
// manifest <queries> entries — added by plugins/withShareQueries.js.
import { Linking, Share } from "react-native";
import type { ShareIntent } from "../lib/share";

export async function openShareNative(intent: ShareIntent) {
  // 1. Try the native app deep-link (best UX: lands in the real composer).
  try {
    if (await Linking.canOpenURL(intent.nativeUrl)) {
      return await Linking.openURL(intent.nativeUrl);
    }
  } catch { /* fall through */ }
  // 2. App not installed / scheme refused → web intent in a Custom Tab.
  try {
    return await Linking.openURL(intent.webUrl);
  } catch { /* fall through */ }
  // 3. Last resort → OS Share-sheet. Always works; user picks any app. text has the link inline.
  return Share.share({ message: intent.text });
}
