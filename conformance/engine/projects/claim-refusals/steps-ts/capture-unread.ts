import { defineStep, z } from "nukadoko";
import makeThing from "./make-thing.ts";

export default defineStep({
  description: "A refused claim",
  pattern: "the price is {price:int}",
  args: z.object({ price: z.number().describe("The price"), made: z.string().describe("The thing") }),
  from: { made: [makeThing, "thing"] },
  claims: [{ actual: "made", compare: "equal", expected: { literal: "price" } }],
});
