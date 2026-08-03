import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a greeting to {name:string}",
  description: "Greet someone",
  args: z.object({ name: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
