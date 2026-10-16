import { readFileSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// What a script that takes piped input does. A run has no input to give a
// step, so stdin must read as empty, not fail or wait for a writer.
export default defineStep({
  pattern: "the step reads stdin",
  description: "Reads file descriptor 0 to its end",
  args: z.object({}),
  returns: z.object({ length: z.number() }),
  mutates: false,
  async run() {
    return { length: readFileSync(0, "utf8").length };
  },
});
