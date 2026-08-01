import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Then-position step (mutates: false, legal there): navigates ctx.page() to
// /whoami and reads back the JSON body the server rendered into the page,
// proving this step's browser context is the *same* one browser-login.ts (a
// Background step) opened earlier in this same scenario.
export default defineStep({
  pattern: "the browser sees who is logged in",
  description: "Return the Cookie header the server saw on this browser request",
  args: z.object({}),
  returns: z.object({ cookie: z.string().nullable() }),
  mutates: false,
  async run(ctx) {
    const page = await ctx.page();
    await page.goto(`${ctx.baseURL}/whoami`);
    const text = await page.textContent("body");
    return JSON.parse(text ?? "null") as { cookie: string | null };
  },
});
