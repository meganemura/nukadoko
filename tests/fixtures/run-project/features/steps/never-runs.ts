import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Defined (not undefined) on purpose: failing.feature places this step after
// one that always fails, so the scenario record must show it as "skipped",
// not "undefined" — proving the skip path is reached via a real, matchable
// step, not by accident.
export default defineStep({
  pattern: "this step never runs",
  description: "Should always be skipped, never executed",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
