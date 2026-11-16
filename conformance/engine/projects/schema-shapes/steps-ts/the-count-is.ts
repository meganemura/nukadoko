import { defineStep, z } from "nukadoko";
import counted from "./open-todos-counted.ts";

export default defineStep({
  description: "The count of open todos is a number",
  pattern: "the count is {expected:int}",
  args: z.object({ expected: z.number().describe("The expected count"), count: counted.returns.shape.count }),
  from: { count: [counted, "count"] },
  claims: [{ actual: "count", compare: "equal", expected: "expected" }],
});
