import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// One of two steps sharing a single `nuka run` pickle's `ctx` — the pair
// (this file and env-beta.ts) is the reset regression test for
// `beginStep` (env-reads-and-mutates-doc task spec, completion bullet 5):
// each step's own required name must land only on its own receipt, never
// on its sibling's.
export default defineStep({
  pattern: "step alpha requires its own env var",
  description: "Calls ctx.requireEnv with a name unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ requireEnv }) {
    requireEnv("ALPHA_ONLY");
    return { ok: true };
  },
});
