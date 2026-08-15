import { defineConfig } from "./nukadoko-shim.js";

// Deliberately packs one occurrence of every `nuka check` error category
// into a single project (each of the above errors is detected, at least
// one case each) — see each step file
// under features/steps/ and features/check.feature and features/broken.feature
// for which category each piece triggers.
export default defineConfig({});
