import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-short-string {v:short}",
  description: "Capture {v:short} against z.string()",
  args: z.object({ v: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
