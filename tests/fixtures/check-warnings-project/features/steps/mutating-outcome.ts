import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers the `then-mutates` *warning* (this task's spec, decision 5):
// bound in Then position (see features/then-position.feature) while
// declaring the default `mutates: true`. No longer an error — the
// declaration alone can't settle whether a given occurrence's execution
// actually writes, so `nuka check` warns and leaves the judgment to review
// plus run-time observation (docs/spec.md "Keyword semantics"). This is why
// this fixture — otherwise about config-coherence warnings only — belongs to
// this project: proving "warnings only still exits 0" needs a warning from
// every category that can appear alongside the others.
export default defineStep({
  pattern: "a mutating outcome {x:string}",
  description: "d",
  args: z.object({ x: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
