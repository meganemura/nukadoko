import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose (same reasoning as tests/fixtures/
// run-directory-project): every scenario here exercises `nuka run
// --concurrency`'s own worker orchestration without needing a browser or an
// HTTP server.
export default defineConfig({});
