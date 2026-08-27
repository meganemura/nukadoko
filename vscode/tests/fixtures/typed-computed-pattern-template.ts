import { defineStep } from "nukadoko";
import { z } from "zod";

// `pattern` is a template literal with a `${...}` substitution -- the other
// shape of "computed value" tests/extraction/step-extraction.test.ts's
// "unresolved" case covers (see typed-computed-pattern-variable.ts for the
// plain-variable shape).
const article = "a";

export default defineStep({
  pattern: `${article} todo titled {title:string} is added`,
  description: "pattern is a template literal with an expression",
  args: z.object({ title: z.string() }),
  returns: z.object({ title: z.string() }),
  mutates: false,
  run(_fixtures, args) {
    return args;
  },
});
