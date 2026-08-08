import { z } from "zod";
import { defineStep } from "nukadoko";

// A plain `throw` classifies as ErrorKind "step_error" (receipt/types.ts:
// "every other throw is step_error"), which is one of only two kinds Allure
// maps to its own "failed" status rather than "broken"
// (src/report/allure/map-scenario.ts's FAILED_KINDS) -- the selftest-allure
// task spec's assertion 1 needs every deliberate failure in mixed.feature to
// land in Allure's "failed" bucket, because the scenario record nuka run
// prints on stdout (selftest-suite's own comparison input) carries a step's
// pass/fail/skipped status but never its ErrorKind, so a "broken" step here
// would be a count assertion 1 could not derive from that stdout alone.
export default defineStep({
  pattern: "a step that always throws",
  description: "Always throws a plain error, to exercise Allure's Step error category",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    throw new Error("boom: this step always fails");
  },
});
