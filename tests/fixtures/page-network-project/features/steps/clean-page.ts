import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// tests/page-network.test.ts's own fixture (p3b-page-network task spec,
// completion condition 6: "落としたものが無い step に http_omitted キーが
// 出ないこと") — a page load with nothing but its own document response, no
// image/stylesheet/script and no extra fetch, so `http_omitted` must be
// absent from this receipt entirely, not present-and-empty.
export default defineStep({
  description: "Load a page with no assets and nothing left out of http.jsonl (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const page = await ctx.page();
    await page.goto("/clean");
    return { ok: true };
  },
});
