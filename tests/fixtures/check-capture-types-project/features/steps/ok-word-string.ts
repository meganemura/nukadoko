import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-word-string {v:word}",
  description: "Capture {v:word} against z.string()",
  args: z.object({ v: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
