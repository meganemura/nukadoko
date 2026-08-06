import { defineConfig } from "./nukadoko-shim.js";

// fb5-import-error-line task spec: a step file that fails to import with an
// esbuild transform error rather than a runtime error, so the message
// itself carries a `<path>:<line>:<col>:` location — this project exists
// only to prove `nuka check` extracts that location into `CheckIssue.line`.
export default defineConfig({});
