import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Hits the test server's /whoami, which echoes back whatever Cookie header
// it received (or null): proves whether a restored session's cookie
// actually reached the server on a later, separate `do` invocation.
export default defineStep({
  description: "Return the Cookie header the server saw on this request",
  args: z.object({}),
  returns: z.object({ cookie: z.string().nullable() }),
  mutates: false,
  async run(ctx) {
    const res = await (await ctx.request()).get("/whoami");
    return res.json();
  },
});
