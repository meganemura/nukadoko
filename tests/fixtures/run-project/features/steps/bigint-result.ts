import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Returns a value `JSON.stringify` cannot serialize on its own (a BigInt).
// Zod validates and passes it through fine (`z.bigint()` matches it), so
// this step's own status is "ok" all the way through `run()`. The failure
// this exists to exercise happens one layer further out, once the executor
// itself tries to write that validated result to disk: `nuka run`'s own
// general backstop (src/run/run-scenario.ts) still has to leave a real,
// failed step record behind, not crash the whole invocation.
export default defineStep({
  pattern: "a step returns a value JSON cannot serialize",
  description: "Returns a BigInt, which JSON.stringify cannot serialize on its own",
  args: z.object({}),
  returns: z.object({ count: z.bigint() }),
  mutates: false,
  async run() {
    return { count: 10n };
  },
});
