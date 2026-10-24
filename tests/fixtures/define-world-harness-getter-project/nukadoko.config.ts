import { defineConfig } from "./nukadoko-shim.js";

// No program file: the scenario never opens a browser. The failure under test
// happens while the World is being wrapped, before any step body runs.
export default defineConfig({});
