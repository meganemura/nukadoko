import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Someone lights the hall",
  pattern: "the hall is lit",
  args: z.object({}),
  requires: ["inside"],
  mutates: false,
  run() {},
});
