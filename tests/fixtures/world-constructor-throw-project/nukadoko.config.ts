import { defineConfig } from "./nukadoko-shim.js";

// No program file: both scenarios stay off the wire. The coverage is the World
// constructor throw, not a browser.
export default defineConfig({});
