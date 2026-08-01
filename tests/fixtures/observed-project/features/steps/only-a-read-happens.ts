import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Then-position step that only reads: proves the same declared-mutating
// vocabulary can legitimately pass in Then position when its own execution
// never writes (docs/spec.md "Keyword semantics" — the same-sentence-in-
// both-positions case this task's spec's decision 4 is about).
export default defineStep({
  pattern: "only a read happens",
  description: "GET only, in Then position — must pass",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const request = await ctx.request();
    await request.get("/ok");
    return { ok: true };
  },
});
