import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Resolves on the very first `fn` call — proves a no-op wait's receipt says
// so (attempts: 1, outcome: "resolved"), the whole reason `polls` exists:
// this and a genuinely slow poll look identical without it (ctx-poll-receipt
// task spec, test bullet 1).
export default defineStep({
  pattern: "a step polls and resolves on the first try",
  description: "ctx.poll's fn returns a value on the very first call",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    await ctx.poll(async () => "ready", { interval: 5, timeout: 200 });
    return { ok: true };
  },
});
