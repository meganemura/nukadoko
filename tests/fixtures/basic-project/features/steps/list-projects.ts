import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// No `pattern`/`patterns`: CLI-only vocabulary, invisible to feature files
// but importable by other steps (docs/spec.md "Typed steps").
export default defineStep({
  description: "List all known project ids",
  args: z.object({}),
  returns: z.object({ ids: z.array(z.string()) }),
  mutates: false,
  async run() {
    return { ids: [] };
  },
});
