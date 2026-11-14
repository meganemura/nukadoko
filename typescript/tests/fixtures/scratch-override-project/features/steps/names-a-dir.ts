import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a scratch directory is named",
  description: "Returns whatever scratch.dir gives back",
  args: z.object({}),
  returns: z.object({ dir: z.string() }),
  mutates: false,
  async run({ scratch }) {
    return { dir: scratch.dir("x") };
  },
});
