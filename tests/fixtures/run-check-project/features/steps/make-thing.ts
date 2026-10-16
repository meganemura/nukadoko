import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a thing {name:string} exists",
  description: "Create a thing",
  args: z.object({ name: z.string() }),
  returns: z.object({ name: z.string() }),
  mutates: true,
  async run({}, args) {
    return { name: args.name };
  },
});
