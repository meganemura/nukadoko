import { defineStep } from "nukadoko";
import { openCart, openCartArgs, openCartReturns } from "./lib/cart.js";

// args/returns come from the shared unit, not declared again here: the
// spec (../../e2e/cart.spec.ts) and this step import the exact same zod
// values, so the two homes cannot drift into disagreeing about the shape.
export default defineStep({
  pattern: "a cart is opened",
  description: "Open a new cart against the fixture's request-based app",
  args: openCartArgs,
  returns: openCartReturns,
  async run({ request }) {
    return await openCart(request);
  },
});
