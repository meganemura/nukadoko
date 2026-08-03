import { label } from "allure-js-commons";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Proves item 2's kind-independence claim directly: a *typed* step importing the
// allure-js facade on its own, with no World in sight, still gets this
// step's own `declared` on its receipt — the same mechanism a compat step's
// glue uses, not a special case for compat.
export default defineStep({
  pattern: "a typed step declares an allure label directly",
  description: "Call the allure facade directly from a typed step's own run()",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    await label("typed-owner", "team-nukadoko");
    return {};
  },
});
