import { defineConfig } from "./nukadoko-shim.js";

// The program is in the program, whose url is a placeholder
// tests/parts.test.ts rewrites once the local http server's actual port is
// known.
// url is a placeholder, rewritten by tests/parts.test.ts once the local
// http server's actual port is known (same convention as observed-project):
// this fixture is about `call`'s own mechanics. `readonly` is this
// project's one static piece, used by calls-mutating-part.ts's own
// read-only test.

export default defineConfig({
  program: () => ({
    url: "http://127.0.0.1:1",
    environments: {
      readonly: { policy: "read-only" },
    },
  }),
});
