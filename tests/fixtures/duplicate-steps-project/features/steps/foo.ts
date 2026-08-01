import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a first foo step",
  description: "First definition of a step named foo",
  args: z.object({}),
  returns: z.object({ ok: z.literal(true) }),
  mutates: false,
  async run() {
    return { ok: true as const };
  },
});
