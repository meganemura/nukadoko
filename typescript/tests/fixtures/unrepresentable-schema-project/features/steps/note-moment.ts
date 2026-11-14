import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A date is not a JSON value in either input or output mode. Args are
// rendered as the input schema, and this one still cannot be represented.
export default defineStep({
  description: "Note a moment",
  args: z.object({ at: z.date() }),
  returns: z.object({ noted: z.boolean() }),
  mutates: false,
  async run({}, args) {
    return { noted: args.at instanceof Date };
  },
});
