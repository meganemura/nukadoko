import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// See attach-alpha.ts's own header — this is that test's second step.
export default defineStep({
  pattern: "step beta attaches its own evidence",
  description: "Attaches a name unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    await evidence.attach("beta-only.txt", "beta");
    return { ok: true };
  },
});
