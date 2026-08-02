import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A minimal step with no purpose beyond being discoverSteps()'s direct load
// target for tests/discover-steps.test.ts's module-identity test, paired
// with consumer.ts's relative import of this same file.
export default defineStep({
  pattern: "the producer step runs",
  description: "No-op step; exists only so discovery has a file to load directly",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
