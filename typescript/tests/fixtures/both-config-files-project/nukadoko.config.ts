import { defineConfig } from "./nukadoko-shim.js";

// Deliberately present alongside nukadoko.config.mts in this same
// directory: this fixture exists to prove loadConfig refuses outright
// when both names exist, rather than silently picking one.
export default defineConfig({});
