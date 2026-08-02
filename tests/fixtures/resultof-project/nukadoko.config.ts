import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same as run-project's own rationale
// (m2pre-resultof task spec, scope item 5): every scenario here is about
// `ctx.resultOf`'s chain mechanics, not evidence collection, so no browser
// and no HTTP server are needed.
export default defineConfig({});
