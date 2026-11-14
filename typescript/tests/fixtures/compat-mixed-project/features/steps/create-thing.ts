import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A typed step whose validated result the next typed step reads via
// `ctx.resultOf` (proving resultOf works normally even in a scenario that
// also has compat steps in it).
export default defineStep({
  pattern: "a thing is created",
  description: "Create a thing (no network — resultOf is the point here)",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  run() {
    return { id: "t1" };
  },
});
