import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Always throws — the "a failed record still becomes a line, with a
// comment naming how it failed" case (docs/spec.md "Harvesting").
export default defineStep({
  pattern: "the risky operation runs",
  description: "Always throws, deterministically, for the failed-record harvest case",
  args: z.object({}),
  returns: z.object({}),
  async run() {
    throw new Error("the risky operation exploded on purpose");
  },
});
