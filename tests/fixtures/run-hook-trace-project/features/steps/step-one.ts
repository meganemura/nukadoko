import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Navigates to a "data:" URL unique to this step (p3d-hook-trace task spec
// test item 5) — proves this step's own trace chunk carries only this
// navigation, never the Before hook's or the AfterStep hook's.
export default defineStep({
  pattern: "the first step touches the browser",
  description: "Navigate to a step-one marker URL",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run(ctx) {
    const page = await ctx.page();
    await page.goto("data:text/html,step-one");
    return { ok: true };
  },
});
