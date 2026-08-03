import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Reads API_TOKEN, then SECOND_KEY, then API_TOKEN again — the receipt's
// own `required_env` order (first-read order) and dedup (a repeat read
// cited once) are the whole point of this step (env-reads-and-mutates-doc
// task spec, completion bullets 1-2).
export default defineStep({
  pattern: "a step reads two required env vars, one of them twice",
  description: "Calls ctx.requireEnv three times: A, B, A again",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    ctx.requireEnv("API_TOKEN");
    ctx.requireEnv("SECOND_KEY");
    ctx.requireEnv("API_TOKEN");
    return { ok: true };
  },
});
