import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// One of two steps sharing a single `nuka run` pickle's `ctx` — the pair
// (this file and poll-beta.ts) is the reset regression test for
// `beginStep` (ctx-poll-receipt task spec, test bullet 6): each step's own
// poll must land only on its own receipt, never on its sibling's.
export default defineStep({
  pattern: "poll step alpha runs its own poll",
  description: "Calls ctx.poll with a description unique to this step",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    await ctx.poll(async () => "ready", { interval: 5, timeout: 200, description: "alpha-only" });
    return { ok: true };
  },
});
