import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `tag` is never given by the tests that omit it: exercises `nuka do`'s own
// default fill, where a passing step record's own `args` must show the
// filled value (`tag: "guest"`), not the caller's own omission — the only
// way to tell "the record holds the validated value" apart from "the
// record holds the raw value" when the two would otherwise read identical
// (echo.ts's own args schema has no default to diverge on).
export default defineStep({
  description: "Greet name, filling tag with a default when the caller omits it",
  args: z.object({ name: z.string(), tag: z.string().default("guest") }),
  returns: z.object({ name: z.string(), tag: z.string() }),
  mutates: false,
  async run({}, args) {
    return { name: args.name, tag: args.tag };
  },
});
