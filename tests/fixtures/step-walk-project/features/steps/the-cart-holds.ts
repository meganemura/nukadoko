import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import cart from "./a-cart.js";

export default defineStep({
  pattern: "the cart holds {count:int} items",
  description: "Check how many items the cart holds",
  args: z.object({
    count: z.number().describe("How many items the line says the cart holds"),
    held: z.number().describe("How many items the cart was made with"),
  }),
  from: { held: [cart, "items"] },
  claims: [{ actual: "held", compare: "equal", expected: "count" }],
});
