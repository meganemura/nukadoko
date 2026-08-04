import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The outer poll's own `fn` awaits a separate, inner `ctx.poll` call before
// resolving — proves multiple polls in one step land in *completion* order,
// not call order: the inner poll finishes (and is recorded) before the
// outer one's own `fn` even returns (ctx-poll-receipt task spec, test
// bullet 8; docs/spec.md "Receipts": "a nested poll finishes before the one
// containing it").
export default defineStep({
  pattern: "a step nests one poll inside another",
  description: "An outer ctx.poll's fn awaits a separate inner ctx.poll",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    await ctx.poll(
      async () => {
        await ctx.poll(async () => "inner-ready", { interval: 5, timeout: 200, description: "inner" });
        return "outer-ready";
      },
      { interval: 5, timeout: 200, description: "outer" },
    );
    return { ok: true };
  },
});
