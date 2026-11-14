import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The named capture "a" consumes one args key, leaving exactly one required
// key ("rest") for the attached data table to bind to (src/run/match-step.ts's
// "final argument" rule) — the success half of table.feature.
export default defineStep({
  pattern: "a table thing {a:string} exists",
  description: "Binds an attached table to the one unconsumed required key",
  args: z.object({ a: z.string(), rest: z.array(z.array(z.string())) }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
