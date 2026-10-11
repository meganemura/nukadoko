import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the fixture finishes",
  description: "Names tenant and ledger, then returns",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  // `tenant` and `ledger` are user fixtures. `StepFixtures` does not list
  // them, so the bag is loosely typed, the same escape hatch the other
  // fixture projects use.
  async run({ tenant, ledger }: any) {
    void tenant;
    void ledger;
    return {};
  },
});
