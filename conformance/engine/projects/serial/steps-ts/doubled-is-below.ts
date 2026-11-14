import { defineStep, z } from "nukadoko";
import double from "./double.ts";

export default defineStep({
  description: "The number an earlier step doubled is less than a bound",
  pattern: "the doubled number is below {bound:int}",
  args: z.object({
    bound: z.number().describe("The bound"),
    doubled: double.returns.shape.doubled,
  }),
  from: { doubled: [double, "doubled"] },
  claims: [{ actual: "doubled", compare: "less-than", expected: "bound" }],
});
