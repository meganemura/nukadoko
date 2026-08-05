import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Browser-path counterpart to login.ts: navigates page to /set-cookie
// so the *browser context's* cookie jar (independent from the request
// context's — this task's spec, decision 3) picks up the cookie.
export default defineStep({
  description: "Navigate to /set-cookie so the browser context picks up a cookie",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run({ page, baseURL }) {
    const response = await page.goto(`${baseURL}/set-cookie`);
    return { ok: response !== null && response.ok() };
  },
});
