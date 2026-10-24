import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createThing from "./create-thing.js";

// A step that runs and reads the earlier step's validated result through
// ctx.resultOf, so its own result proves resultOf still works beside a
// compat step. It runs rather than claims: inside a claim step's observe,
// resultOf throws, because a value from an earlier step reaches a claim
// only through from, where the record names its origin.
export default defineStep({
  pattern: "the created thing is read via resultOf",
  description: "Read the earlier step's validated result through ctx.resultOf",
  args: z.object({}),
  returns: z.object({ created: z.string().nullable() }),
  mutates: false,
  run({ resultOf }) {
    return { created: resultOf(createThing)?.id ?? null };
  },
});
