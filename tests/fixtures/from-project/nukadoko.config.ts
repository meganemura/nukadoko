import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same rationale as resultof-project's own
// (m6a-from-core task spec): every scenario here is about `from`'s chain
// mechanics, not evidence collection, so no browser and no HTTP server are
// needed.
export default defineConfig({});
