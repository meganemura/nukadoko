import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Holds the process open long enough for a test to deliver SIGINT or
// SIGTERM after both fixtures have logged setup. The wait is longer than
// the test's own budget, so a run that ignores the signal cannot finish
// the step and tear down on the normal path before the test gives up.
export default defineStep({
  pattern: "the fixture stays open",
  description: "Names tenant and ledger, then waits",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ tenant, ledger }: { tenant: { id: string }; ledger: { id: string } }) {
    void tenant;
    void ledger;
    await new Promise((resolve) => setTimeout(resolve, 120_000));
    return {};
  },
});
