import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the thing {name:string} exists",
  description: "Check that a thing exists",
  args: z.object({ name: z.string() }),
  returns: z.object({ found: z.boolean() }),
  mutates: false,
  async run() {
    return { found: true };
  },
});
