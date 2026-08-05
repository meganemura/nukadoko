import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Browser-path counterpart to whoami.ts: navigates page to /whoami and
// reads the JSON body chromium renders into the page (wrapped in <pre> for a
// JSON response) back out via page.textContent(), rather than
// page.evaluate(() => document...): this project's tsconfig has no `dom`
// lib (nothing else here needs one), and textContent()'s signature is
// plain Node-side TypeScript with no in-browser globals to type against.
export default defineStep({
  description: "Return the Cookie header the server saw on this browser request",
  args: z.object({}),
  returns: z.object({ cookie: z.string().nullable() }),
  mutates: false,
  async run({ page, baseURL }) {
    await page.goto(`${baseURL}/whoami`);
    const text = await page.textContent("body");
    return JSON.parse(text ?? "null") as { cookie: string | null };
  },
});
