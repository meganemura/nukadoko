import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: unknown-parameter-type ("frobnicate" is not a registered
// cucumber-expressions parameter type; no custom-type registration API
// exists yet).
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
