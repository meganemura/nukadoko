import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A pattern with optional text (`widget(s)`) and alternation (`is/are`) —
// reversing either has no single answer, so a harvested line for this step
// is expected to fail the round trip (docs/spec.md "Harvesting": "A
// pattern may carry optional text ... and reversing one does not have a
// single answer").
export default defineStep({
  pattern: "a widget(s) is/are created",
  description: "Create one or more widgets; pattern carries optional text and alternation on purpose",
  args: z.object({}),
  returns: z.object({ created: z.boolean() }),
  async run() {
    return { created: true };
  },
});
