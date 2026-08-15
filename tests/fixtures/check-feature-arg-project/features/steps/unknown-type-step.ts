import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: unknown-parameter-type ("frobnicate" is not a registered
// cucumber-expressions parameter type). Present so this fixture always has
// one binding-check error regardless of which feature (if any) a `nuka
// check` invocation is pointed at — binding-check runs off `featuresDir`'s
// own vocabulary, not the checked feature.
export default defineStep({
  pattern: "an unknown type {value:frobnicate} thing",
  description: "d",
  args: z.object({ value: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
