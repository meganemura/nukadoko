import { defineConfig } from "./nukadoko-shim.js";

// baseURL is a placeholder, rewritten by tests/observed.test.ts once the
// local http server's actual port is known — this fixture is about
// measured network writes, not baseURL layering, which
// tests/environment.test.ts already covers against its own fixture. The
// `readonly` environment is this project's one static piece: read-only
// policy is a config-time fact, not something a test needs to rewrite.
export default defineConfig({
  baseURL: "http://127.0.0.1:1",
  environments: {
    readonly: { policy: "read-only" },
  },
});
