import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A name that could resolve outside the evidence directory is refused, not
// sanitized — the uncaught
// `InvalidEvidenceNameError` becomes this step's own failure, the same way
// any other uncaught throw inside `run` does.
export default defineStep({
  pattern: "a step attaches with a name that tries to escape the evidence directory",
  description: "Calls evidence.attach with a name containing '..'",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    await evidence.attach("../escape.txt", "x");
    return { ok: true };
  },
});
