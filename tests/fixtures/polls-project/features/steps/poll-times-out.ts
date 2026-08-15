import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `fn` always returns undefined — `ctx.poll`'s own `PollTimeoutError`
// propagates out of `run`, failing the step; proves the timed-out poll's
// own record still lands on that failed step's step record (the case this
// whole feature exists for).
// timeout/interval kept small so this test stays fast.
export default defineStep({
  pattern: "a step polls and times out",
  description: "ctx.poll's fn never returns a value",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ poll }) {
    await poll(async () => undefined, { interval: 5, timeout: 20 });
    return { ok: true };
  },
});
