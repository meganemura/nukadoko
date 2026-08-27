import { defineStep } from "nukadoko";
import { z } from "zod";

// `pattern` is a variable reference, not a literal -- computing it requires
// running this file, which the extension must never do. Proves the
// "unresolved" branch of tests/extraction/step-extraction.test.ts.
const dynamicPattern = "a {x:int} widgets";

export default defineStep({
  pattern: dynamicPattern,
  description: "pattern is a variable, not a literal",
  args: z.object({ x: z.number() }),
  returns: z.object({ x: z.number() }),
  mutates: false,
  run(_fixtures, args) {
    return args;
  },
});
