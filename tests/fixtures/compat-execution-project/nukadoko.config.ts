import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: every scenario in this fixture stays off the wire (m21b-
// compat-execution task spec coverage is entirely about step/hook timeouts,
// pending/skipped returns, done-callback detection, and the hook parameter
// — none of it touches Playwright/HTTP).
export default defineConfig({});
