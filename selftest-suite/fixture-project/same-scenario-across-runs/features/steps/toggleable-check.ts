import { z } from "zod";
import { defineStep } from "nukadoko";

// Responsibility: the one step selftest-suite/features/steps/
// same-scenario-across-runs.ts's own glue runs twice per scenario -- pass
// then fail, or fail then pass -- entirely from outside toggle.feature
// itself. The feature text never changes between the two runs, only this
// step's own outcome, which is exactly what those two scenarios need to
// tell "the same scenario changed status" apart from "a different scenario
// ran". A claim step: observe reads the flag and the claim says it is not
// "fail", a word the sentence states. It reads process.env rather than
// `ctx.requireEnv` or the `env` fixture: this flag is test-harness
// control, not a real dependency the scenario under test has on its own
// environment, so recording it as one (`required_env`) would misrepresent
// what the scenario needs to run.
export default defineStep({
  pattern: "the toggleable check is not told to fail",
  description: "Holds or breaks depending on an env var the test harness sets, never the feature text",
  args: z.object({}),
  observe() {
    return { told: process.env.NUKADOKO_SELFTEST_TOGGLE ?? "" };
  },
  claims: [{ actual: "told", compare: "not-equal", expected: { literal: "fail" } }],
});
