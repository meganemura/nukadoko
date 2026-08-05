import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import fromSource from "./from-source.js";

// Baseline (m7b-unfillable-key task spec): the required key has no capture
// and no table/docstring, but it does have a declared `from` — the third
// fill path, and the one this task's spec is explicit must not double-report
// with src/check/from-order.ts. Every scenario that uses this step also
// binds from-source.ts earlier, so from-order itself stays silent too —
// there is nothing here for either check to say.
export default defineStep({
  pattern: "the widget from source is used",
  description: "A required args key declared via from",
  args: z.object({ sourceId: z.string() }),
  returns: z.object({ sourceId: z.string() }),
  from: { sourceId: [fromSource, "id"] },
  async run({}, args) {
    return { sourceId: args.sourceId };
  },
});
