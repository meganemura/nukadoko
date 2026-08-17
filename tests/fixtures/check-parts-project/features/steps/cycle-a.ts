import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// One half of a two-step parts cycle, paired with cycle-b.ts. Starts with
// an empty `parts` list because cycle-b.ts is the one that closes the loop
// once both steps exist — see that file's own comment for why this needs
// no circular import between the two files.
export default defineStep({
  pattern: "cycle step a runs",
  description: "one half of a parts cycle, on purpose, for nuka check to find",
  args: z.object({}),
  returns: z.object({}),
  parts: [],
  async run() {
    return {};
  },
});
