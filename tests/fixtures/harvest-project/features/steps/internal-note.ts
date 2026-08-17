import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// CLI-only vocabulary: no `pattern`/`patterns` at all, on purpose — the
// "step has no pattern, becomes a comment" case (docs/spec.md
// "Harvesting").
export default defineStep({
  description: "Record an internal note; CLI-only, never bound to Gherkin text",
  args: z.object({ note: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  async run({}, args) {
    return { ok: args.note.length > 0 };
  },
});
