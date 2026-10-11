import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a fixture whose teardown can leak a secret is used",
  description: "Destructures leakyTeardown; the step succeeds and the teardown fails",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  async run({ leakyTeardown }: { leakyTeardown: { id: string } }) {
    return { id: leakyTeardown.id };
  },
});
