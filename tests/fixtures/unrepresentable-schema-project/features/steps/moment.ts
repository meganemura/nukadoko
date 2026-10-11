import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `z.date()` is not a JSON value. The args side of this step is ordinary
// so a failure on returns must not drop the args schema.
export default defineStep({
  description: "Name a moment",
  args: z.object({ label: z.string() }),
  returns: z.object({ label: z.string(), at: z.date() }),
  mutates: false,
  async run({}, args) {
    return { label: args.label, at: new Date(0) };
  },
});
