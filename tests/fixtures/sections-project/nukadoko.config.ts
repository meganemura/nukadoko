import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same as resultof-project's own rationale
// (t3-sections task spec): every scenario here is about `ctx.section`'s own
// bookkeeping, not evidence collection, so no browser and no HTTP server are
// needed.
export default defineConfig({});
