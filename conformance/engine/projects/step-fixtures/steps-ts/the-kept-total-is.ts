import { defineStep, z } from "nukadoko";
import waitAndKeep from "./wait-and-keep.ts";

export default defineStep({
  description: "The total kept is the number the line states",
  pattern: "the kept total is {expected:int}",
  args: z.object({
    expected: z.number().int().describe("The total the line expects"),
    total: waitAndKeep.returns.shape.total,
  }),
  from: { total: [waitAndKeep, "total"] },
  claims: [{ actual: "total", compare: "equal", expected: "expected" }],
});
