import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Declares `mutates: false` (a lie) but issues a POST under a read-only
// environment. t2-trust-declaration task spec: nukadoko trusts the
// declaration instead of measuring against it, so this now succeeds like any
// other `mutates: false` step would — the lie stays visible in the receipt's
// `observed`, it just no longer fails the run that exposed it.
export default defineStep({
  description: "Declares mutates: false but actually POSTs (a lie the declaration is trusted over)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ request }) {
    await request.post("/ok");
    return { ok: true };
  },
});
