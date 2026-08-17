import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import mutatingPart from "./mutating-part.js";

// Declares `mutates: false` (this step's own declared intent) but calls a
// part declared `mutates: true` — proves `ctx.call`'s own read-only refusal
// checks the *part's* declaration, not the caller's (docs/spec.md "Parts").
// Both CLI-only-reachable (`nuka do calls-mutating-part`) and pattern-bound
// (`nuka run`), so one step file covers both paths.
export default defineStep({
  pattern: "a mutates: false composite calls a mutating part",
  description: "Declares mutates: false but calls a part declared mutates: true",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  parts: [mutatingPart],
  async run({ call }) {
    await call(mutatingPart, {});
    return {};
  },
});
