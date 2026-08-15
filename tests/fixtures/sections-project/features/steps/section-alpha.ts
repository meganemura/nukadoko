import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// One of two steps sharing a single `nuka run` pickle's `ctx` — the pair
// (this file and section-beta.ts) is the reset regression test for
// `beginStep` (t3-sections task spec, decision 4; test bullet 4): each
// step's own label must land only on its own step record, never on its
// sibling's.
export default defineStep({
  pattern: "step alpha runs its own section",
  description: "Calls ctx.section with a label unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ section }) {
    section("alpha-only");
    return { ok: true };
  },
});
