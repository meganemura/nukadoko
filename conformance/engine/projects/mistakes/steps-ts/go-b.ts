import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Go a number of steps, again",
  pattern: "I go {b:int}",
  args: z.object({ b: z.number().describe("The steps") }),
  run() {
    return {};
  },
});
