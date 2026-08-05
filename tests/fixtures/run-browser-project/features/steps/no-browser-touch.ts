import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Proves p3a-trace-per-step task spec's own completion condition 6: a step
// that never destructures `page` carries no `evidence.trace` of its own,
// even when the Background step ahead of it (browser-login.ts) already
// launched the browser for this same scenario — the trace chunk this
// task's spec asks for is opened lazily, per step, on that step's own bag
// construction, never eagerly just because a browser already exists.
export default defineStep({
  pattern: "the step does nothing with the browser",
  description: "Return without ever destructuring page (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run() {
    return { ok: true };
  },
});
