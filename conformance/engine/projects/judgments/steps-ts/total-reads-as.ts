import { defineStep, z } from "nukadoko";
import aCart from "./a-cart.ts";

export default defineStep({
  pattern: "the total reads as {quality:string}",
  description: "The total, for a reader to judge against the quality",
  args: z.object({ quality: z.string().describe("What the total should read as"), total: aCart.returns.shape.total }),
  from: { total: [aCart, "total"] },
  claims: [{ actual: "total", compare: "judged-as", expected: "quality" }],
});
