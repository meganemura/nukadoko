import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Baseline (m7b-unfillable-key task spec): the pattern captures nothing, but
// the table attached to this pickle line is the one thing that fills the
// required key — src/check/feature-check.ts's own "exactly one unconsumed
// required key" rule (`table-docstring-key-mismatch`) resolves this to
// filled, so the new check must stay silent about it too.
export default defineStep({
  pattern: "a widget batch exists",
  description: "A required args key filled by a table attachment",
  args: z.object({ rows: z.array(z.array(z.string())) }),
  returns: z.object({ count: z.number() }),
  async run(_ctx, args) {
    return { count: args.rows.length };
  },
});
