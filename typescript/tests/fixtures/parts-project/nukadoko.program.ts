import { defineProgram } from "./nukadoko-shim.js";

// url is a placeholder, rewritten by tests/parts.test.ts once the local
// http server's actual port is known (same convention as observed-project):
// this fixture is about `call`'s own mechanics. `readonly` is this
// project's one static piece, used by calls-mutating-part.ts's own
// read-only test.
export default defineProgram({
  url: "http://127.0.0.1:1",
  environments: {
    readonly: { policy: "read-only" },
  },
});
