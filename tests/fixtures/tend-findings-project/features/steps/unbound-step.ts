import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `pattern-unbound` target: has a pattern, but no scenario in this fixture
// ever calls it — a typed step meant only for the CLI should carry no
// pattern at all (docs/spec.md "Tending"), so this is the drift the finding
// is named for.
export default defineStep({
  pattern: "a step nobody calls happens",
  description: "Never invoked by any feature in this fixture",
  rationale: "Exists solely to give tests/tend.test.ts a pattern-unbound target",
  args: z.object({}),
  returns: z.object({ done: z.boolean().describe("always true") }),
  async run() {
    return { done: true };
  },
});
