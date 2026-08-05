import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Same shape as step-one.ts, its own distinct marker URL — this scenario's
// second step, so the AfterStep hook below runs after it too (p3d-hook-trace
// task spec test item 2: 2 executed steps -> 2 separate AfterStep chunks).
export default defineStep({
  pattern: "the second step touches the browser",
  description: "Navigate to a step-two marker URL",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const page = await ctx.page();
    await page.goto("data:text/html,step-two");
    return { ok: true };
  },
});
