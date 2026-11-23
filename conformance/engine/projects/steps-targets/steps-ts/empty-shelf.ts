import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Start with a shelf that holds nothing",
  pattern: "an empty shelf",
  args: z.object({}),
  run() {
    return {};
  },
});
