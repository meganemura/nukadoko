import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a step runs no command",
  description: "Runs nothing",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  run() {
    return { ok: true };
  },
});
