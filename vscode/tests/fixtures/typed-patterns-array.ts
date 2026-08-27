import { defineStep } from "nukadoko";
import { z } from "zod";

// Two aliases of the same step, both bound through `patterns` rather than
// `pattern` -- tests/extraction/step-extraction.test.ts's own "one
// declaration, two patterns" fixture.
export default defineStep({
  patterns: ["a {x:int}", "an {x:int}"],
  description: "accepts either article before the count",
  args: z.object({ x: z.number() }),
  returns: z.object({ x: z.number() }),
  mutates: false,
  run(_fixtures, args) {
    return args;
  },
});
