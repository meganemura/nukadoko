import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// tests/signoff-rot.test.ts edits this file in place for two of its own
// cases: deleting it entirely (record cites a step gone from the
// vocabulary) and tightening `returns` to add a field the already-frozen
// result doesn't carry (record's frozen result no longer passes the current
// schema). Kept as its own file, never shared with create-cart.ts, so
// either edit stays scoped to exactly the step it's testing.
export default defineStep({
  pattern: "the cart total is {total:string} dollars",
  description: "Checks the cart's total",
  args: z.object({ total: z.string() }),
  returns: z.object({ total: z.string() }),
  mutates: false,
  async run({}, args) {
    return { total: args.total };
  },
});
