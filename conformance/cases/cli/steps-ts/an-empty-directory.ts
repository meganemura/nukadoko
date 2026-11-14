import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A fresh, empty scratch directory to run the command in",
  pattern: "an empty directory",
  args: z.object({}),
  returns: z.object({ dir: z.string().describe("The scratch directory") }),
  mutates: false,
  run({ scratch }) {
    return { dir: scratch.dir() };
  },
});
