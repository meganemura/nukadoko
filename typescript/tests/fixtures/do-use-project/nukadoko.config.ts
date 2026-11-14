import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same rationale as from-project's own:
// every step here is about `nuka do --use`'s own
// resolution mechanics, not evidence collection, so no browser and no HTTP
// server are needed. A dedicated fixture rather than reusing from-project
// (already exercised by tests/from-chain.test.ts) so this slice's own tests
// never share mutable fixture state with another.
export default defineConfig({});
