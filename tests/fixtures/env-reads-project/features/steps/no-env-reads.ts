import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Never calls `ctx.requireEnv` — proves `required_env` is omitted, not
// written as an empty array, when a step doesn't use it (env-reads-and-
// mutates-doc task spec, completion bullet 3).
export default defineStep({
  pattern: "a step with no required env reads runs",
  description: "Never calls ctx.requireEnv",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run() {
    return { ok: true };
  },
});
