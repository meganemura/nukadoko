import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Baseline: the key is optional, so the
// schema itself already says absent is fine — no capture, table/docstring,
// or from needed at all, and this is the fourth silent path.
export default defineStep({
  pattern: "a widget note is filed",
  description: "An optional args key with no capture, table, or from at all",
  args: z.object({ note: z.string().optional() }),
  returns: z.object({ filed: z.boolean() }),
  async run() {
    return { filed: true };
  },
});
