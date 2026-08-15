import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The chain's producer side: a plain,
// deterministic step with no network/browser at all, so this fixture's
// resultOf tests are about the chain mechanism itself, not evidence
// collection. The `name === "boom"` throw is a deliberate escape hatch, used
// by resultof-boundary.feature to put a *failed* run of this exact step
// behind it and prove that a failed run is never chained.
export default defineStep({
  pattern: "a listing {name:string} is created",
  description: "Create a listing and return its id and name",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  async run({}, args) {
    if (args.name === "boom") {
      throw new Error("listing creation failed on purpose");
    }
    return { id: `l_${args.name}`, name: args.name };
  },
});
