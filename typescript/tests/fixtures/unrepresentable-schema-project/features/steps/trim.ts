import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A transform is a real args schema (callers pass a string, the step sees
// it trimmed) and JSON Schema has no way to say what the transform does.
// `nuka describe` used to abort on that with only zod's message.
export default defineStep({
  description: "Trim a name",
  args: z.object({ name: z.string().transform((value) => value.trim()) }),
  returns: z.object({ name: z.string() }),
  mutates: false,
  async run({}, args) {
    return { name: args.name };
  },
});
