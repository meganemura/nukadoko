import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A deliberately slow step, for racing a second request against a busy
// session: the same shape tests/fixtures/live-session-project's own
// slow.ts already uses for the same reason.
export default defineStep({
  description: "Wait `ms` milliseconds (default 300)",
  args: z.object({ ms: z.number().optional() }),
  returns: z.object({ waited_ms: z.number() }),
  mutates: false,
  async run({}, args) {
    const ms = args.ms ?? 300;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { waited_ms: ms };
  },
});
