import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Never calls ctx.poll — proves `polls` is omitted, not written as an empty
// array, when a step doesn't use it (ctx-poll-step-record task spec, test
// bullet 5), the same convention `sections` follows.
export default defineStep({
  pattern: "a step with no polls runs",
  description: "Never calls ctx.poll",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run() {
    return { ok: true };
  },
});
