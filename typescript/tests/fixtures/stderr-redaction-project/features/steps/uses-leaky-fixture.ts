import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a fixture whose teardown can leak a secret is used",
  description: "Destructures leakyTeardown; the step succeeds and the teardown fails",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  // `leakyTeardown` is a user fixture, not a member of `StepFixtures`. The
  // same loosely typed destructuring the other teardown fixtures use.
  async run({ leakyTeardown }: any) {
    return { id: leakyTeardown.id };
  },
});
