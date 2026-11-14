import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `brokenTeardown` is a user fixture, not a builtin: the same loosely
// typed destructuring tests/fixtures/user-fixtures-project's own steps use
// for the same structural reason.
export default defineStep({
  pattern: "a fixture whose teardown fails is used",
  description: "Destructures brokenTeardown; the step itself succeeds, only its teardown fails",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  async run({ brokenTeardown }: any) {
    return { id: brokenTeardown.id };
  },
});
