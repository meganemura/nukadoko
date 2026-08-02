import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Follows a step this fixture expects to be refused before it runs (m2pre-
// resultof task spec, decision 3); must be skipped, not executed.
export default defineStep({
  pattern: "an unreachable step never runs",
  description: "Trivial step that must be skipped, not executed",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
