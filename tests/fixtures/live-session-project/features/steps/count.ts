import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Module-scope, not fixture-backed: this is the fixture's own proof that a
// live session's world persists across executions. Discovery re-imports
// every step file through a fresh tsx namespace per run (src/discover/
// discover-steps.ts's own `register({ namespace: randomUUID() })`), so a
// plain (non-live) `nuka do` re-imports this module — and resets `counter`
// to 0 — every single call; two `nuka do --session <name>` calls delegated
// to the same live session's own daemon (src/live/daemon.ts) instead share
// one process, hence one import of this module, hence one `counter`.
let counter = 0;

export default defineStep({
  description:
    "Increment and return a module-scope counter: 1 the first time this module is ever imported, " +
    "2 the second time only if that import is the same one (i.e. this ran against a live session)",
  args: z.object({}),
  returns: z.object({ count: z.number() }),
  mutates: true,
  async run() {
    counter += 1;
    return { count: counter };
  },
});
