import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Mutating (the `defineStep` default), used to exercise `nuka run`'s
// read-only refusal (m2pre-resultof task spec, decision 3) — nothing it
// does is actually destructive, and it never even reaches its own body under
// that policy: `mutates` is what matters here, not the run function.
export default defineStep({
  pattern: "a declared mutating step runs",
  description: "A step that mutates (default), used to exercise nuka run's read-only refusal",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  async run() {
    return { ok: true };
  },
});
