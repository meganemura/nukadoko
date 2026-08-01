import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deliberately throws: exercises `nuka do`'s "run threw" receipt path.
export default defineStep({
  description: "Always throws to exercise the run-threw receipt path",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    throw new Error("boom");
  },
});
