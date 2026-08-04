import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// tests/trace-actions-receipt.test.ts's own fixture: `page.goto()` records a
// trace `before` entry whose `params.url` is the exact URL navigated to
// (measured directly against a real trace.zip while building this task,
// p3a-trace-per-step task spec) — embedding a secret in the URL's own query
// string is the most direct way to prove `actions[].url` gets redacted the
// same single pass the rest of the receipt already goes through (this
// task's spec, completion condition 5).
export default defineStep({
  pattern: "the page visits a url containing a secret",
  description: "Navigate to a URL whose query string carries a secret (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const token = ctx.requireEnv("URL_TOKEN");
    const page = await ctx.page();
    const response = await page.goto(`${ctx.baseURL}/?token=${token}`);
    return { ok: response !== null && response.ok() };
  },
});
