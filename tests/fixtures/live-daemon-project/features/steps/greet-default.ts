import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `tag` is never given by the tests that omit it: exercises a live
// session's own default fill, where a passing step record's own `args`
// must show the filled value (`tag: "guest"`), not the caller's own
// omission — echo.ts's own args schema has no default to diverge on, so it
// cannot tell "the record holds the validated value" apart from "the
// record holds the raw value" the way this step can.
export default defineStep({
  description: "Greet name, filling tag with a default when the caller omits it",
  args: z.object({ name: z.string(), tag: z.string().default("guest") }),
  returns: z.object({ name: z.string(), tag: z.string() }),
  mutates: false,
  async run({}, args) {
    return { name: args.name, tag: args.tag };
  },
});
