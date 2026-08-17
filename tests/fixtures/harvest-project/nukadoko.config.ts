import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same rationale as do-use-project's own:
// every step here is about `nuka harvest`'s own rendering and round trip,
// not evidence collection, so no browser and no HTTP server are needed.
export default defineConfig({});
