import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The count is a number",
  pattern: "the count is {expected:int}",
  args: z.object({ expected: z.number().describe("The count") }),
  observe() {
    return { actual: 1 };
  },
  claims: [{ actual: "actual", compare: "equal", expected: "expected" }],
});
