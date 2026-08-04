import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The failure-path counterpart to browser-login.ts (fb4-evidence-time task
// spec's own acceptance criterion: a browser execution's receipt carries
// exactly one screenshot, final.png, on both a passing and a failing run —
// the case the former second-screenshot-on-failure behavior existed for).
// Opens the browser like any other browser-path step, then always throws,
// so `dispose()` still runs (src/cli/do.ts calls it regardless of how `run`
// ended) and `finalize()` still captures `final.png`.
export default defineStep({
  description: "Open the browser, then throw, to produce a failed browser receipt",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const page = await ctx.page();
    await page.goto(`${ctx.baseURL}/whoami`);
    throw new Error("deliberate failure for the fb4-evidence-time browser-failure test");
  },
});
