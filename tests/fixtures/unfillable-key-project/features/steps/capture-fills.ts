import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Baseline (m7b-unfillable-key task spec): the required key is filled by a
// named capture in the matched pattern itself — the first of the four fill
// paths docs/spec.md "Typed steps" describes, and the one the new check must
// stay silent for.
export default defineStep({
  pattern: "a widget named {name:string} is captured",
  description: "A required args key filled by a pattern capture",
  args: z.object({ name: z.string() }),
  returns: z.object({ name: z.string() }),
  async run({}, args) {
    return { name: args.name };
  },
});
