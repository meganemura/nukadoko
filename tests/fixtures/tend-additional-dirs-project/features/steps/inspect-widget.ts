import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Bound only from accepted/inspect.feature, outside featuresDir — proves
// additionalFeatureDirs is what keeps pattern-unbound from misreporting
// this step. `mutates: false` doubles
// as this fixture's read-only-count case (decision 5).
export default defineStep({
  pattern: "a widget {name:string} is inspected",
  description: "Reads a widget's current state",
  rationale: "Read-only lookup; nothing to declare beyond its own name",
  args: z.object({ name: z.string().describe("the widget's name") }),
  returns: z.object({ state: z.string().describe("the widget's current state") }),
  mutates: false,
  async run({}, args) {
    return { state: `inspected:${args.name}` };
  },
});
