import { label } from "allure-js-commons";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Proves the step record's existing whole-object
// redaction already covers declared's own string fields — no special-cased
// redaction path was written for `declared` itself.
export default defineStep({
  pattern: "a typed step declares a label with a secret value",
  description: "Call the allure facade with a secret env value as the label's own value",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ env }) {
    await label("token", env.SHIM_SECRET ?? "missing");
    return {};
  },
});
