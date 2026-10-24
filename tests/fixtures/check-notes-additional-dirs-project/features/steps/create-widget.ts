import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Bound only by features/widgets.feature, inside featuresDir — pattern-
// unbound must never fire for this step regardless of additionalFeatureDirs
// (tests/scan-dirs.test.ts's own control case).
export default defineStep({
  pattern: "a widget {name:string} is created",
  description: "Creates a widget",
  args: z.object({ name: z.string().describe("the widget's name") }),
  returns: z.object({ id: z.string().describe("the created widget's id") }),
  async run({}, args) {
    return { id: `w_${args.name}` };
  },
});
