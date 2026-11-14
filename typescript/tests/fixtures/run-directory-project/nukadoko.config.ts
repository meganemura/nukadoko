import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose (same reasoning as tests/fixtures/
// run-project): every scenario here exercises `nuka run`'s own
// directory-target selection without
// needing a browser or an HTTP server.
export default defineConfig({});
