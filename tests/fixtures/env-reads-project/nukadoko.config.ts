import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same rationale as sections-project's own
// (env-reads-and-mutates-doc task spec): every scenario here is about
// `ctx.requireEnv`'s own bookkeeping — what lands on the step record's
// `required_env` — not evidence collection, so no browser and no HTTP
// server are needed. `.env` supplies real values for the keys these steps
// require; `MISSING_KEY` is deliberately absent from it.
export default defineConfig({
  envFiles: [".env"],
});
