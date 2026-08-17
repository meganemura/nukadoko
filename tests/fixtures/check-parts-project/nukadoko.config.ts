import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose — every scenario here exists only to be a
// structurally broken (or genuinely correct) `parts` target for `nuka
// check` to find; nothing about it needs a browser or an HTTP server.
export default defineConfig({});
