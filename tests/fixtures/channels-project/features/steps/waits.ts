import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a step waits",
  description: "Waits 900 ms and does nothing else",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { ok: true };
  },
});
