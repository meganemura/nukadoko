import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the thing {name:string} is there",
  description: "Look at a thing",
  args: z.object({ name: z.string() }),
  returns: z.object({ found: z.boolean() }),
  mutates: false,
  async run() {
    return { found: true };
  },
});
