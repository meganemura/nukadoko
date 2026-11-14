import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A pattern that captures one key twice",
  pattern: "I pair {a:int} and {a:int}",
  args: z.object({ a: z.number().describe("A number") }),
  run() {
    return {};
  },
});
