import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same rationale as from-project's own
// (m6a-from-core task spec): every scenario here is about `from`'s multiple-
// candidate mechanics (m7a-from-alternatives task spec), not evidence
// collection, so no browser and no HTTP server are needed.
export default defineConfig({});
