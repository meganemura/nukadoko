import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Requires a key that has no value in .env — `ctx.requireEnv` records the
// name before it throws `MissingEnvError` (create-context.ts's own
// requireEnv), so the failed receipt still shows what this step asked for
// (env-reads-and-mutates-doc task spec, completion bullet 4, the
// requirement's own reason for existing).
export default defineStep({
  pattern: "a step requires a missing env var",
  description: "Calls ctx.requireEnv with a key that has no value",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    ctx.requireEnv("MISSING_KEY");
    return { ok: true };
  },
});
