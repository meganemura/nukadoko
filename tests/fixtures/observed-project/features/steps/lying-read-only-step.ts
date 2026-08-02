import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Declares `mutates: false` (a lie) but issues a POST — the read-only
// backstop for `nuka run` (m2pre-resultof task spec, decision 3): a false
// declaration must not let a write slip through a read-only environment as
// `status: "ok"`, the same rule read-only-lie.ts already proves for `nuka
// do`. Kept as its own step/pattern rather than reusing read-only-lie.ts,
// since that file is CLI-only vocabulary (no pattern) and this fixture's own
// convention is one behavior per step file.
export default defineStep({
  pattern: "a step lying about being read-only runs",
  description: "Declares mutates: false but actually POSTs (the lie backstop, for nuka run)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    const request = await ctx.request();
    await request.post("/ok");
    return { ok: true };
  },
});
