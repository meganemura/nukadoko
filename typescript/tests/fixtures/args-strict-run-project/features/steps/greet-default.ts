import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// This pattern never captures `tag`: exercises `nuka run`'s own default
// fill, where a passing step record's own `args` must show the filled
// value (`tag: "anon"`), not the raw binding output — greet.ts's own args
// schema (this same fixture) has no default to diverge on, so it cannot
// tell "the record holds the validated value" apart from "the record holds
// the raw value" the way this step can.
export default defineStep({
  pattern: "a greeting for {name:string} with an unset tag exists",
  description: "Return a greeting for name, filling tag with a default when it is unset",
  args: z.object({ name: z.string(), tag: z.string().default("anon") }),
  returns: z.object({ greeting: z.string(), tag: z.string() }),
  mutates: false,
  async run({}, args) {
    return { greeting: `hello ${args.name}`, tag: args.tag };
  },
});
