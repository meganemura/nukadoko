import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Its stripped pattern "duplicate text {string}" collides, kind-crossing,
// with compat-glue.ts's `Given("duplicate text {string}", ...)` — proving
// duplicate-pattern detection reaches across typed/compat (this task's
// spec, item 6: "duplicate は kind をまたいで検出"). Never referenced by any
// feature file: duplicate-pattern is a whole-vocabulary static check, not a
// per-feature one.
export default defineStep({
  pattern: "duplicate text {value:string}",
  description: "d",
  args: z.object({ value: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
