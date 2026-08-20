import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a process-scope fixture whose teardown fails is used",
  description: "test",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  async run({ brokenProcessTeardown }: any) {
    return { id: brokenProcessTeardown.id };
  },
});
