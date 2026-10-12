import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-anon-string {v:}",
  description: "Capture {v:} against z.string()",
  args: z.object({ v: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
