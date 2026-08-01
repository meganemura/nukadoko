import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the project {name:string} can be looked up",
  description: "Look up a project by name",
  args: z.object({ name: z.string() }),
  returns: z.object({ found: z.boolean() }),
  mutates: false,
  async run() {
    return { found: true };
  },
});
