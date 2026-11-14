import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A trivial part, used by calls-undeclared-part.ts to prove `call()`
// refuses a step its caller never declared in `parts` — before this step's
// own `run` ever starts.
export default defineStep({
  description: "A trivial part; must never actually run in the undeclared-part test",
  args: z.object({}),
  returns: z.object({}),
  async run() {
    return {};
  },
});
