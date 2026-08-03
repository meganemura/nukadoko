import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Follows the write in then-position.feature's second scenario. It used to
// prove that a measured-failed preceding step skips the rest of the
// scenario; since t2-trust-declaration removed that measured failure, this
// step now actually runs and proves the opposite — the declared-non-mutating
// write no longer stops the scenario at all.
export default defineStep({
  pattern: "a step after the write also runs",
  description: "Trivial step that now actually executes, since the write above no longer fails",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
