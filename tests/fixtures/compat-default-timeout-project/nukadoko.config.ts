import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: every scenario in this fixture stays off the wire (m22-
// compat-run-scope task spec coverage is entirely about setDefaultTimeout
// interacting with compat step/hook timeouts, not Playwright/HTTP).
export default defineConfig({});
