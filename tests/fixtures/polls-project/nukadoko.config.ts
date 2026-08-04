import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same as sections-project's own rationale
// (ctx-poll-receipt task spec): every scenario here is about `ctx.poll`'s
// own bookkeeping, not evidence collection, so no browser and no HTTP
// server are needed.
export default defineConfig({});
