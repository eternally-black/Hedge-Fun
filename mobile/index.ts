// Privy RN SDK polyfills — MUST be imported before anything else (docs.privy.io/basics/react-native).
import "fast-text-encoding";
import "react-native-get-random-values";
import "@ethersproject/shims";

import { registerRootComponent } from "expo";

import App from "./App";

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
