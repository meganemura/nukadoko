import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// See section-alpha.ts's own header — this is that test's second step.
export default defineStep({
  pattern: "step beta runs its own section",
  description: "Calls ctx.section with a label unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ section }) {
    section("beta-only");
    return { ok: true };
  },
});
