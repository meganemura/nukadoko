import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A step that writes while declaring `mutates: false`: the declaration is
// what nukadoko trusts, not what execution measures, so this occurrence
// must pass; the write still lands on the step record's `observed`.
export default defineStep({
  pattern: "a write happens",
  description: "POST, declared mutates: false; must pass, measured anyway",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ request }) {
    await request.post("/ok");
    return { ok: true };
  },
});
