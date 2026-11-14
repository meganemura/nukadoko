import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the rows count {n:int}",
  args: z.object({ n: z.number().describe("The n") }),
  observe() {
    return {};
  },
  claims: [{ actual: "rows", count: true, compare: "matches", expected: "n" }],
});
