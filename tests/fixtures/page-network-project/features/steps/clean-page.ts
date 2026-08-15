import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// tests/page-network.test.ts's own fixture —
// a page load with nothing but its own document response, no
// image/stylesheet/script and no extra fetch, so `http_omitted` must be
// absent from this step record entirely, not present-and-empty.
export default defineStep({
  description: "Load a page with no assets and nothing left out of http.jsonl (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page }) {
    await page.goto("/clean");
    return { ok: true };
  },
});
