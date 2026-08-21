import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Together with open-cart.spec.ts (same pattern, different file name):
// docs/spec.md "The second door" second named mistake, a step file named
// like a spec. See that file's own comment for the collision this pair
// exists to reproduce.
export default defineStep({
  pattern: "the cart is opened",
  description: "Open the cart",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run() {
    return { ok: true };
  },
});
