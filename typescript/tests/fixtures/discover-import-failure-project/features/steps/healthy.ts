import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Fixture-only: proves a healthy file's own discovery is unaffected by a
// sibling file's import failure (tests/discover-steps.test.ts).
export default defineStep({
  pattern: "a healthy thing happens",
  description: "Fixture-only: always registers successfully.",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
