import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// See env-alpha.ts's own header — this is that test's second step.
export default defineStep({
  pattern: "step beta requires its own env var",
  description: "Calls ctx.requireEnv with a name unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    ctx.requireEnv("BETA_ONLY");
    return { ok: true };
  },
});
