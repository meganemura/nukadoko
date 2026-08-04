import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The one step this fixture's vocabulary carries — nothing under either
// scanned directory references it, which is fine: this fixture exists to
// exercise scanning, not binding.
export default defineStep({
  pattern: "a no-op happens",
  description: "Does nothing",
  rationale: "Gives this fixture a non-empty vocabulary",
  args: z.object({}),
  returns: z.object({}),
  async run() {
    return {};
  },
});
