import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-word-boolean {v:word}",
  description: "Capture {v:word} against z.boolean()",
  args: z.object({ v: z.boolean() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
