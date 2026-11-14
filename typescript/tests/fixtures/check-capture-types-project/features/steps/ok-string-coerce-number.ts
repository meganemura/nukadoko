import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-string-coerce-number {v:string}",
  description: "Capture {v:string} against z.coerce.number()",
  args: z.object({ v: z.coerce.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
