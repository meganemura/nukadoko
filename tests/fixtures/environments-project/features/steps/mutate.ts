import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Mutating (the `defineStep` default) step used only to exercise
// `policy: "read-only"` refusal (this task's spec, decision 4) — nothing it
// does is actually destructive; `mutates` is what matters here, not the body.
export default defineStep({
  description: "A step that mutates (default), used to exercise read-only refusal",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  async run() {
    return { ok: true };
  },
});
