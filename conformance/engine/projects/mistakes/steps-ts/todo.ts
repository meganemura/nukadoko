import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "TODO: describe todo",
  pattern: "a step still to describe",
  args: z.object({}),
  run() {
    return {};
  },
});
