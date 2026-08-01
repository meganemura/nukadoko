import { z } from "zod";
import { defineStep } from "../../../nukadoko-shim.js";

export default defineStep({
  pattern: "a second foo step, in a nested directory",
  description: "Second definition of a step also named foo, to trigger a duplicate-name error",
  args: z.object({}),
  returns: z.object({ ok: z.literal(true) }),
  mutates: false,
  async run() {
    return { ok: true as const };
  },
});
