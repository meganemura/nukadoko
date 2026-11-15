import { defineConfig } from "./nukadoko-shim.js";

// No program: every scenario in this fixture stays off the wire (its
// coverage is entirely about setDefaultTimeout
// interacting with compat step/hook timeouts, not Playwright/HTTP).
export default defineConfig({});
