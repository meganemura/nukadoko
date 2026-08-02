import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A typed step reading, via `ctx.request()`, the cookie a *compat* step set
// via `this.openRequest()` earlier in the same pickle — proves 1 pickle = 1
// ctx across kinds (m2b-compat-execution task spec, item 4).
export default defineStep({
  pattern: "the cookie is visible to a typed request",
  description: "Confirm the compat step's cookie is visible to a typed ctx.request()",
  args: z.object({}),
  returns: z.object({ cookie: z.string().nullable() }),
  mutates: false,
  async run(ctx) {
    const res = await (await ctx.request()).get("/whoami");
    const body = (await res.json()) as { cookie: string | null };
    if (!body.cookie || !body.cookie.includes("sid=abc123")) {
      throw new Error(`expected the compat step's cookie to be visible, got ${JSON.stringify(body.cookie)}`);
    }
    return { cookie: body.cookie };
  },
});
