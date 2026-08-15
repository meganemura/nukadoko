import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Second step in transformer-throws.feature — always skipped, since the
// scenario's first step never even reaches matching's "matched" outcome.
// Exists so the scenario has a step
// whose own "skipped" record this task's test can assert on.
export default defineStep({
  pattern: "this step never runs",
  description: "Never actually invoked; proves the rest of the scenario is skipped",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
