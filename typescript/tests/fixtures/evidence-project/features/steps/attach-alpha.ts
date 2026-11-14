import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// One of two steps sharing a single `nuka run` pickle's `ctx` — the pair
// (this file and attach-beta.ts) proves `beginStep`'s reset moves the
// evidence directory (and the name registry) per step, the same regression
// tests/sections.test.ts already covers for `ctx.section`.
export default defineStep({
  pattern: "step alpha attaches its own evidence",
  description: "Attaches a name unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    await evidence.attach("alpha-only.txt", "alpha");
    return { ok: true };
  },
});
