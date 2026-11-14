import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Go a number of steps",
  pattern: "I go {a:int}",
  args: z.object({ a: z.number().describe("The steps") }),
  run() {
    return {};
  },
});
