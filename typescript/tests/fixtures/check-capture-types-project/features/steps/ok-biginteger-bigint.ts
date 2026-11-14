import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-biginteger-bigint {v:biginteger}",
  description: "Capture {v:biginteger} against z.bigint()",
  args: z.object({ v: z.bigint() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
