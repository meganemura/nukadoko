import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a fixture that never calls use is used",
  description: "Destructures neverCallsUse — this fixture returns without ever calling use()",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ neverCallsUse }: any) {
    void neverCallsUse;
    return {};
  },
});
