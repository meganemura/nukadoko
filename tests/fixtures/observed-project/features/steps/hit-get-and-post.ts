import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// CLI-only vocabulary (no pattern): one GET then one POST through
// ctx.request(), used to prove receipt.observed's `{1, 1}` tally (this
// task's spec, decision 1: non-GET/HEAD counts as a write).
export default defineStep({
  description: "Hit the test server with one GET then one POST",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  async run(ctx) {
    const request = await ctx.request();
    await request.get("/ok");
    await request.post("/ok");
    return { ok: true };
  },
});
