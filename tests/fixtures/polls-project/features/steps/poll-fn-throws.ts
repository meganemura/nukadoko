import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `fn` throws on its very first call — `ctx.poll` propagates that throw
// unchanged, failing the step; proves the failed poll's own record
// (outcome: "failed") still lands on that failed step's receipt
// (ctx-poll-receipt task spec, test bullet 4).
export default defineStep({
  pattern: "a step polls with a predicate that throws",
  description: "ctx.poll's fn throws instead of returning",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ poll }) {
    await poll(async () => {
      throw new Error("predicate exploded");
    });
    return { ok: true };
  },
});
