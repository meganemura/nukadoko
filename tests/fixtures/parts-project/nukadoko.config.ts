import { defineConfig } from "./nukadoko-shim.js";

// baseURL is a placeholder, rewritten by tests/parts.test.ts once the local
// http server's actual port is known — same convention as tests/fixtures/
// observed-project's own config, for the same reason: this fixture is about
// `call`'s own mechanics, not baseURL layering. `readonly` is this
// project's one static piece (same convention as observed-project's own
// config): read-only policy is a config-time fact, not something a test
// needs to rewrite, used by calls-mutating-part.ts's own read-only test.
export default defineConfig({
  baseURL: "http://127.0.0.1:1",
  environments: {
    readonly: { policy: "read-only" },
  },
});
