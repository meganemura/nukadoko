import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-double-number-default {v:double}",
  description: "Capture {v:double} against z.number().default(0)",
  args: z.object({ v: z.number().default(0) }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
