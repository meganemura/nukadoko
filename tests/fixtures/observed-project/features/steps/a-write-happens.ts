import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Then-position step that writes while declaring `mutates: false`
// (t2-trust-declaration task spec): the declaration is what nukadoko trusts
// now, not what execution measures, so this occurrence must pass — the
// write still lands on the step record's `observed`, just no longer fails it.
export default defineStep({
  pattern: "a write happens",
  description: "POST, in Then position, declared mutates: false — must pass, measured anyway",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ request }) {
    await request.post("/ok");
    return { ok: true };
  },
});
