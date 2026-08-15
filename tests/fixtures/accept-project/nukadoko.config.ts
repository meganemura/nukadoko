import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose: `nuka accept` (m4b-accept task spec)
// only cares about record.json/record.json shape and git state, so none of
// this fixture's scenarios need a browser or an HTTP server.
export default defineConfig({});
