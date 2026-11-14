import { z } from "zod";
import openCart from "./open-cart.js";
import { defineStep } from "../../nukadoko-shim.js";

// A genuinely correct `from` chain — the control case proving the
// malformed-entry check that guards `nuka steps`/`nuka describe`/`nuka
// check` stays silent, and keeps rendering `from` normally, for a step that
// has nothing wrong with it, sitting in the same vocabulary as this
// fixture's two malformed steps.
export default defineStep({
  pattern: "the cart is archived",
  description: "Archive the cart opened earlier",
  args: z.object({ cartId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { cartId: [openCart, "id"] },
  async run() {
    return { archived: true };
  },
});
