import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the mjs step runs",
  description: "Proves discovery reads a .mjs step file (p10-step-discovery task spec)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run() {
    return { ok: true };
  },
});
