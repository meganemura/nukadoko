import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A typed step reading, via `request`, the cookie a *compat* step set
// via `this.openRequest()` earlier in the same pickle: proves 1 pickle = 1
// ctx across kinds.
export default defineStep({
  pattern: "the cookie {cookie:string} is visible to a typed request",
  description: "Confirm the compat step's cookie is visible to a typed request",
  args: z.object({ cookie: z.string() }),
  async observe({ request }) {
    const res = await request.get("/whoami");
    const body = (await res.json()) as { cookie: string | null };
    return { seen: body.cookie };
  },
  claims: [{ actual: "seen", compare: "contains-text", expected: "cookie" }],
});
