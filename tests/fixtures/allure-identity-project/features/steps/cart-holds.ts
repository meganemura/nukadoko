import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import aCart from "./a-cart.js";

export default defineStep({
  pattern: "the cart holds {count:int} items",
  description: "Checks the number of items in the cart",
  args: z.object({ count: z.number().int().nonnegative(), held: z.number().int() }),
  from: { held: [aCart, "count"] },
  claims: [{ actual: "held", compare: "equal", expected: "count" }],
});
