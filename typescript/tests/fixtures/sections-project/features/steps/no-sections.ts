import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Never calls `ctx.section` — proves `sections` is omitted, not written as
// an empty array, when a step doesn't use it.
export default defineStep({
  pattern: "a step with no sections runs",
  description: "Never calls ctx.section",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run() {
    return { ok: true };
  },
});
