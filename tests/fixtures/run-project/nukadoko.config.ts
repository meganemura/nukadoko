import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose: every scenario here exercises `nuka
// run`'s matching/skip/record logic without needing a browser or an HTTP
// server (m1-run task spec, scope item 4's non-browser test list).
export default defineConfig({});
