import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `step-rationale-missing` target: CLI-only on purpose (no `pattern`), same
// reason undescribed-field-step.ts is — isolates this finding from
// pattern-unbound. `rationale` is simply omitted; `Step.rationale` is then
// `undefined` (src/step/define-step.ts's `defineStep`, no default).
export default defineStep({
  description: "Log a note with no rationale on file",
  args: z.object({ text: z.string().describe("the note's text") }),
  returns: z.object({ logged: z.boolean().describe("always true") }),
  async run() {
    return { logged: true };
  },
});
