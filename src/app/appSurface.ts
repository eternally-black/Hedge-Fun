// Mount point for anything that must cover the APP and nothing else.
//
// On desktop the app renders as a 402px device mock centred in the page, so a `position: fixed`
// overlay escapes it and covers the browser window instead — which is exactly what the first
// version of the consent sheet did. Overlays portal onto this element and use `position: absolute`,
// the same way BalanceSheet already works as a direct child of it.
//
// Its own module rather than an export from page.tsx: importing a value from a Next route module
// drags the whole page into every consumer's graph.
export const APP_SURFACE_ID = "hf-app-surface";
