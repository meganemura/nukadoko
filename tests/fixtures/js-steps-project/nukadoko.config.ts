import { defineConfig } from "./nukadoko-shim.js";

// p10-step-discovery task spec: a suite whose step definitions are plain
// .js and .mjs, not .ts -- discoverSteps only picked up .ts before this
// fixture's own task, which left a suite like this one invisible to
// discovery and every scenario reporting "undefined step" instead of the
// real cause. tests/run.test.ts uses this project to prove `nuka run`
// actually executes both extensions, not just discovers them.
export default defineConfig({});
