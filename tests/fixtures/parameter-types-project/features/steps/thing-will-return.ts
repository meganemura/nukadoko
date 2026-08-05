import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// docs/spec.md's own `negation` example: `will{negated:negation} return`
// binds a plain `z.boolean()` args key instead of a stringly enum like
// `z.enum(["", " not"])` (the dhis2 boolean-polarity pain the parameter-
// types-design.md note names). Deliberately no CLI-only vocabulary: this
// step exists purely so tests/parameter-types.test.ts can drive it through
// the matching pipeline (build bindings, match, bind args) directly.
export default defineStep({
  pattern: "the job will{negated:negation} return",
  description: "Report whether the job will return a negated result",
  args: z.object({ negated: z.boolean() }),
  returns: z.object({ negated: z.boolean() }),
  mutates: false,
  async run({}, args) {
    return { negated: args.negated };
  },
});
