import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A fully healthy, pattern-bound step whose pattern references the
// config-defined "used-type" parameter type (features/tending.feature binds
// it) — the typed-pattern half of parameter-type-unused.ts's "used" proof;
// compat-glue.ts's shout-compat.ts pattern is the compat half.
export default defineStep({
  pattern: "a {level:used-type} note is logged",
  description: "Log a note at the given level",
  rationale: "Exists to exercise the typed side of a config parameter type actually being referenced",
  args: z.object({ level: z.string().describe("the note's level, using the used-type parameter type") }),
  returns: z.object({ logged: z.boolean().describe("always true") }),
  async run() {
    return { logged: true };
  },
});
