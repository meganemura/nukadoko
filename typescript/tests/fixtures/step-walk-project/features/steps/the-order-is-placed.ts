import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import cart from "./a-cart.js";

// Fails on an empty cart, so a walk can pause after a failed step.
export default defineStep({
  pattern: "the order is placed",
  description: "Place the order for the cart",
  args: z.object({ items: z.number().describe("How many items the cart holds") }),
  from: { items: [cart, "items"] },
  returns: z.object({ placed: z.boolean().describe("Whether the order was placed") }),
  mutates: true,
  async run({}, args) {
    if (args.items === 0) throw new Error("the cart is empty");
    return { placed: true };
  },
});
