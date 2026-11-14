import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A pattern with a capture that has no name",
  pattern: "I count {int}",
  args: z.object({}),
  run() {
    return {};
  },
});
