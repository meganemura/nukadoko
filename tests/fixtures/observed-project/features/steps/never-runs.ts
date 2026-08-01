import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Follows the write in then-position.feature's second scenario; must be
// skipped once the preceding step is measured-failed.
export default defineStep({
  pattern: "a step after the write never runs",
  description: "Trivial step that must be skipped, not executed",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
