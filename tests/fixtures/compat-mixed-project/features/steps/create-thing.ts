import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A typed step whose validated result the next typed step reads via
// `ctx.resultOf` (proving resultOf works normally even in a scenario that
// also has compat steps in it — m2b-compat-execution task spec, "混在
// scenario ... typed 側の resultOf が混在でも通常どおり動く").
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
