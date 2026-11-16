import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Make a total of the number the line states",
  pattern: "a total of {total:int} is made",
  args: z.object({ total: z.number().int().describe("The total to make") }),
  returns: z.object({ total: z.number().int().describe("The total made") }),
  // Keeps nothing.
  mutates: false,
  run({}, { total }) {
    return { total };
  },
});
