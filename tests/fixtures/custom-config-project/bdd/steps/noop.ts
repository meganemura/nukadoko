import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Does nothing; proves discovery honored a custom featuresDir",
  args: z.object({}),
  returns: z.object({ ok: z.literal(true) }),
  mutates: false,
  async run() {
    return { ok: true as const };
  },
});
