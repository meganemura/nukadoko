import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Return nothing with no returns declared",
  pattern: "nothing is kept",
  args: z.object({}),
  mutates: false,
  run() {},
});
