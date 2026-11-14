import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Bound in features/no-then.feature, a scenario with no Then line, so
// `nuka check` reports the `scenario-without-then` warning. This fixture is
// otherwise about config-coherence warnings: proving "warnings only still
// exits 0" needs a warning from a feature file beside the config ones.
export default defineStep({
  pattern: "a mutating outcome {x:string}",
  description: "d",
  args: z.object({ x: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
