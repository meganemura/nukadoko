import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// What a prompt library does: it waits on process.stdin.
export default defineStep({
  pattern: "the step reads process.stdin to its end",
  description: "Reads process.stdin until it ends",
  args: z.object({}),
  returns: z.object({ length: z.number() }),
  mutates: false,
  async run() {
    let length = 0;
    for await (const chunk of process.stdin) length += (chunk as Buffer).length;
    return { length };
  },
});
