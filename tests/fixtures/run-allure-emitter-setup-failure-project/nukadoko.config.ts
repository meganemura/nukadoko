import { defineConfig } from "./nukadoko-shim.js";

// `allure.resultsDir` names a path this fixture's own test blocks with a
// plain file (not a directory) one path segment above it. createAtomicWriter
// (src/report/allure/writer.ts) calls mkdirSync(resultsDir, { recursive:
// true }) unguarded, which throws ENOTDIR against a path like that. Exists
// to reach cli/run.ts's own "Warning: allure emitter setup failed" branch,
// which no other test drives (a working resultsDir never fails, and
// src/report/allure/*.test.ts exercises the emitter directly, never through
// `nuka run`'s own setup).
export default defineConfig({
  allure: { resultsDir: "blocked-by-a-file/allure-results" },
});
