import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose (p4a-fixture-bag task spec): every step
// here exists only to exercise fixture-name extraction/validation — the
// structurally broken ones never actually execute (they are refused before
// `nuka run`/`nuka do` ever start), so nothing here needs a browser or an
// HTTP server.
export default defineConfig({});
