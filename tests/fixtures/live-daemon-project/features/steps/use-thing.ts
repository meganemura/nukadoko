import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createThing from "./create-thing.js";

// The `--use` consumer side: `id` normally comes from a scenario's own
// chain, or, for a single `nuka do --session ... --use <record-id>` call,
// from an earlier execution's own step record.
export default defineStep({
  description: "Echo back the id from create-thing (from create-thing, or --use)",
  args: z.object({ id: z.string() }),
  returns: z.object({ id: z.string() }),
  from: { id: [createThing, "id"] },
  mutates: false,
  async run({}, args) {
    return { id: args.id };
  },
});
