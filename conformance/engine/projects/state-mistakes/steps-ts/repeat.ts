import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Someone repeats",
  pattern: "someone repeats",
  args: z.object({}),
  requires: ["inside", " inside"],
  mutates: false,
  run() {},
});
