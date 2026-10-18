import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose: the tests that use it look at records,
// exit codes, and stderr, so none of this fixture's scenarios need a browser
// or an HTTP server.
export default defineConfig({});
