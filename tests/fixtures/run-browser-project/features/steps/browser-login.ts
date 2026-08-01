import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Background step: navigates ctx.page() to /set-cookie so the browser
// context's cookie jar picks up a cookie the *next* step (browser-whoami.ts)
// must see too — proving the pickle's steps share one ctx (docs/spec.md
// "Running": "Steps in one pickle share one context").
export default defineStep({
  pattern: "the browser logs in",
  description: "Navigate to /set-cookie so the browser context picks up a cookie",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run(ctx) {
    const page = await ctx.page();
    const response = await page.goto(`${ctx.baseURL}/set-cookie`);
    return { ok: response !== null && response.ok() };
  },
});
