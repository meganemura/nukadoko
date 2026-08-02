import { defineConfig } from "./nukadoko-shim.js";

// tests/compat-run.test.ts overwrites this file's `baseURL` at run time with
// a real test server's address (same convention as run-session-project/
// run-browser-project) — only the one scenario that actually opens a
// request context needs it.
export default defineConfig({});
