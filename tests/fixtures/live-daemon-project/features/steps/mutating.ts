import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Declared mutating on purpose: the read-only-policy rejection path, run
// against this project's own `readonly` environment.
export default defineStep({
  description: "A step declared mutating",
  args: z.object({}),
  returns: z.object({ done: z.boolean() }),
  mutates: true,
  async run() {
    return { done: true };
  },
});
