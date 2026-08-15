import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Returns undefined twice, then a value — proves a retried poll's step record
// shows attempts >= 2 and waited_ms > 0 (ctx-poll-step-record task spec, test
// bullet 2). interval kept small so this test stays fast.
export default defineStep({
  pattern: "a step polls and resolves after a few retries",
  description: "ctx.poll's fn returns undefined twice, then a value",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ poll }) {
    let calls = 0;
    await poll(
      async () => {
        calls += 1;
        return calls >= 3 ? "ready" : undefined;
      },
      { interval: 5, timeout: 2000 },
    );
    return { ok: true };
  },
});
