import { expect } from "playwright/test";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// tests/trace-actions-expect.test.ts's own fixture: the target page's own
// script adds `#late` only after a delay, so a web-first assertion
// (`expect(...).toBeVisible()`) has to actually retry instead of passing on
// its very first check — the real-browser proof that `actions` records that
// wait's own duration in `ms` (this task's spec), not 0. `expect` comes from
// `playwright/test`'s own `./test` subpath export, which this task's spec
// already confirmed nukadoko's existing `playwright` dependency (1.61.1)
// carries, so nothing new needed adding to package.json.
export default defineStep({
  pattern: "the page waits for a late element to become visible",
  description: "Navigate to a page whose element appears after a delay, then wait for it (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const page = await ctx.page();
    await page.goto(`${ctx.baseURL}`);
    await expect(page.locator("#late")).toBeVisible({ timeout: 5000 });
    return { ok: true };
  },
});
