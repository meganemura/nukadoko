import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A step declared as a read whose execution only reads.
export default defineStep({
  pattern: "only a read happens",
  description: "GET only; must pass",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ request }) {
    await request.get("/ok");
    return { ok: true };
  },
});
