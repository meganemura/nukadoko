import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A number capture the args read as a string",
  pattern: "I wait {n:int} seconds",
  args: z.object({ n: z.string().describe("The seconds") }),
  run() {
    return {};
  },
});
