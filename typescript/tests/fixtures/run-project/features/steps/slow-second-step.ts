import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Sleeps briefly on purpose (verified by
// observed timestamps, not by reading the code) — a scenario pairing this
// step with a fast one first gives a live, per-step Allure emitter two
// result files whose own mtimes land meaningfully apart; a batched-at-
// scenario-end emitter would write both within a few milliseconds of each
// other regardless of this step's own duration.
export default defineStep({
  pattern: "a slow second step happens",
  description: "Waits briefly, so per-step Allure emission timing is observable",
  args: z.object({}),
  returns: z.object({ waited: z.boolean() }),
  mutates: false,
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { waited: true };
  },
});
