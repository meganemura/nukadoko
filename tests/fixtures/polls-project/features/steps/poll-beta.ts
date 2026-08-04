import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// See poll-alpha.ts's own header — this is that test's second step.
export default defineStep({
  pattern: "poll step beta runs its own poll",
  description: "Calls ctx.poll with a description unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    await ctx.poll(async () => "ready", { interval: 5, timeout: 200, description: "beta-only" });
    return { ok: true };
  },
});
