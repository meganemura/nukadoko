import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Declares `mutates: false` (a lie) but issues a POST — the read-only
// backstop this task's spec's decision 4 requires: a false declaration must
// not let a write slip through a read-only environment as `status: "ok"`.
export default defineStep({
  description: "Declares mutates: false but actually POSTs (a lie, for the read-only backstop test)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const request = await ctx.request();
    await request.post("/ok");
    return { ok: true };
  },
});
