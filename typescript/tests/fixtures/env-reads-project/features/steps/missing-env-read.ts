import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Requires a key that has no value in .env — `ctx.requireEnv` records the
// name before it throws `MissingEnvError` (create-context.ts's own
// requireEnv), so the failed step record still shows what this step asked
// for.
export default defineStep({
  pattern: "a step requires a missing env var",
  description: "Calls ctx.requireEnv with a key that has no value",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ requireEnv }) {
    requireEnv("MISSING_KEY");
    return { ok: true };
  },
});
