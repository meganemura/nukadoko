import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// tests/trace-actions-step-record.test.ts's own fixture: `page.goto()` records a
// trace `before` entry whose `params.url` is the exact URL navigated to
// (measured directly against a real trace.zip) — embedding a secret in the
// URL's own query
// string is the most direct way to prove `actions[].url` gets redacted the
// same single pass the rest of the step record already goes through.
export default defineStep({
  pattern: "the page visits a url containing a secret",
  description: "Navigate to a URL whose query string carries a secret (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page, requireEnv, baseURL }) {
    const token = requireEnv("URL_TOKEN");
    const response = await page.goto(`${baseURL}/?token=${token}`);
    return { ok: response !== null && response.ok() };
  },
});
