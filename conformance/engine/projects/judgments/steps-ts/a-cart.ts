import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a cart holds {count:int} items",
  description: "A cart whose total the step works out",
  args: z.object({ count: z.number().int().describe("How many items") }),
  returns: z.object({ total: z.number().int().describe("The total, worked out in the step") }),
  mutates: false,
  run({}, { count }) {
    return { total: count * 4 };
  },
});
