import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Then-position step that writes: this task's spec's decision 4 says the
// execution's own observed write, not the declaration, fails a Then-bound
// step — `mutates` is left at its default (true) on purpose, since it is
// irrelevant to how this step's own occurrence gets judged.
export default defineStep({
  pattern: "a write happens",
  description: "POST, in Then position — must fail, measured",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  async run(ctx) {
    const request = await ctx.request();
    await request.post("/ok");
    return { ok: true };
  },
});
