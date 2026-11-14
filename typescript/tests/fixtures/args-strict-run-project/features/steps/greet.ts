import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Two patterns, one schema, on purpose: the tagged pattern captures `tag`,
// a key `args` (below) never declares — `nuka run` never runs `nuka
// check`'s own binding analysis before executing a scenario (that is a
// separate command, and its findings are a report, not a gate), so a
// pattern capturing a key its own step's args schema doesn't recognize
// still matches and still reaches args validation. That is exactly the
// case this fixture exists to reach: an extra key a step's own schema
// declares "additionalProperties: false" against (`nuka describe`) but that
// a non-strict `z.object(...).safeParse` would otherwise silently drop
// instead of refusing.
export default defineStep({
  patterns: ["a greeting for {name:string} exists", "a greeting for {name:string} tagged {tag:string} exists"],
  description: "Return a greeting for name",
  args: z.object({ name: z.string() }),
  returns: z.object({ greeting: z.string() }),
  mutates: false,
  async run({}, args) {
    return { greeting: `hello ${args.name}` };
  },
});
