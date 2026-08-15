import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Matches the exact same pickle text as ambiguous-compat.ts's compat step —
// proving ambiguous-match detection reaches across kind too.
export default defineStep({
  pattern: "an ambiguous thing happens",
  description: "d",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
