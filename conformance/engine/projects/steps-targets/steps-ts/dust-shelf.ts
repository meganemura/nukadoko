import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Dust the shelf",
  pattern: "the shelf is dusted",
  args: z.object({}),
  run() {
    return {};
  },
});
