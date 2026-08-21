import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Named like a Playwright spec but is a real, importable step file. A
// step's own name is its file's basename, so this file registers a second
// step, "open-cart.spec", carrying the identical pattern open-cart.ts
// already registers under "open-cart". features/cart.feature's own step
// text matches both, which is the case `nuka check` reports as
// ambiguous-step (docs/spec.md "The second door").
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
