import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose (fb5-needs-inferred task spec, same
// convention as tests/fixtures/fixture-bag-project): every step here
// exists only to exercise `needs_inferred` — every un-destructured one
// never actually runs, so nothing here needs a browser or an HTTP server.
export default defineConfig({});
