import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `tenant` is a user fixture, not a builtin — `StepFixtures`'s own closed
// interface doesn't know its name, so the first argument is loosely typed
// here (this task's spec, "前提": a step consuming a user fixture needs a
// type escape hatch, the same way tests/fixtures/fixture-bag-project's own
// unknown-fixture-step.ts already does for the same structural reason).
export default defineStep({
  pattern: "a tenant is used",
  description: "Destructures the user fixture tenant and reports its id",
  args: z.object({}),
  returns: z.object({ tenantId: z.string() }),
  mutates: false,
  async run({ tenant }: any) {
    return { tenantId: tenant.id };
  },
});
