import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Returns a value whose toJSON throws. Zod passes it through (`z.any()`),
// so this step's own status is "passed" all the way through `run()`. The
// failure this exists to exercise happens one layer further out, once the
// executor itself turns that validated result into a step record: `nuka
// run`'s own general backstop (src/run/run-scenario.ts) still has to leave a
// real, failed step record behind, not crash the whole invocation.
export default defineStep({
  pattern: "a step returns a value JSON cannot serialize",
  description: "Returns a value whose toJSON throws",
  args: z.object({}),
  returns: z.object({ count: z.any() }),
  mutates: false,
  async run() {
    return {
      count: {
        toJSON() {
          throw new Error("this value cannot be written as JSON");
        },
      },
    };
  },
});
