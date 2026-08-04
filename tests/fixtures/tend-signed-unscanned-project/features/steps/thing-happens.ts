import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Bound by features/accepted-inside.feature — that alone is enough to keep
// pattern-unbound quiet for this step, so this fixture needs no
// additionalFeatureDirs entry to stay otherwise clean.
export default defineStep({
  pattern: "a thing happens",
  description: "Records that a thing happened",
  rationale: "Minimal identity step for this fixture; nothing to configure",
  args: z.object({}),
  returns: z.object({}),
  async run() {
    return {};
  },
});
