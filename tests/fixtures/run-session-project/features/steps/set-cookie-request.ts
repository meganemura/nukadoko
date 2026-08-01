import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// First scenario in session-flow.feature: hits /set-cookie via ctx.request()
// so the request context's storageState (later saved to the --session file
// by cli/run.ts's executor) carries the cookie into the *next* scenario.
export default defineStep({
  pattern: "a cookie is set via request",
  description: "Hit /set-cookie so the request context picks up a cookie",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run(ctx) {
    const res = await (await ctx.request()).get("/set-cookie");
    return res.json();
  },
});
