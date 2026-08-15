import { z } from "zod";
import { defineStep } from "nukadoko";

// Responsibility: the one step selftest-suite/features/steps/
// same-scenario-across-runs.ts's own glue runs twice per scenario -- pass
// then fail, or fail then pass -- entirely from outside toggle.feature
// itself. The feature text never changes between the two runs, only this
// step's own outcome, which is exactly what those two scenarios need to
// tell "the same scenario changed status" apart from "a different scenario
// ran". Reads a plain env var rather than nukadoko's own `ctx.requireEnv`:
// this flag is test-harness control, not a real dependency the scenario
// under test has on its own environment, so recording it as one
// (`required_env`) would misrepresent what the scenario actually needs to
// run.
export default defineStep({
  pattern: "the toggleable check passes when told to",
  description: "Passes or throws depending on an env var the test harness sets, never the feature text",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    if (process.env.NUKADOKO_SELFTEST_TOGGLE === "fail") {
      throw new Error("the toggleable check was told to fail");
    }
    return {};
  },
});
