import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Declares `mutates: false` (a lie) but issues a POST under a read-only
// environment via `nuka run`, the same shape read-only-lie.ts already proves
// for `nuka do`. The declaration is trusted
// over what execution measures, so this now succeeds; only a declared
// `mutates: true` step is still refused, before it runs. Kept as its own
// step/pattern rather than reusing read-only-lie.ts, since that file is
// CLI-only vocabulary (no pattern) and this fixture's own convention is one
// behavior per step file.
export default defineStep({
  pattern: "a step lying about being read-only runs",
  description: "Declares mutates: false but actually POSTs (trusted anyway, for nuka run)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ request }) {
    await request.post("/ok");
    return { ok: true };
  },
});
