import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A step no line binds",
  pattern: "nobody writes this line",
  args: z.object({}),
  run() {
    return {};
  },
});
