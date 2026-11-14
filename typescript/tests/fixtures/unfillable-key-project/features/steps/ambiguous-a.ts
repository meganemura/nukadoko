import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Ambiguous-step boundary: a line that
// resolves to 2+ steps already gets its own `ambiguous-step` error
// (src/check/feature-check.ts) — this task's new check must stay silent
// about `serialA`'s own unfillable required key rather than double-report
// the same line under a second code. Paired with ambiguous-b.ts, same
// pattern text.
export default defineStep({
  pattern: "an ambiguous widget exists",
  description: "One half of an ambiguous match, with its own unfillable required key",
  args: z.object({ serialA: z.string() }),
  returns: z.object({ serialA: z.string() }),
  async run({}, args) {
    return { serialA: args.serialA };
  },
});
