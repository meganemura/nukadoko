import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Second scenario in session-flow.feature: a *fresh* ctx (this task's spec,
// decision 8: one ctx per scenario), so the only way this request context
// can carry the first scenario's cookie is via the --session file cli/
// run.ts re-reads at this scenario's own start.
export default defineStep({
  pattern: "the cookie is visible via request",
  description: "Return the Cookie header the server saw on this request",
  args: z.object({}),
  returns: z.object({ cookie: z.string().nullable() }),
  mutates: false,
  async run(ctx) {
    const res = await (await ctx.request()).get("/whoami");
    return res.json();
  },
});
