import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Always returns a shape its own `returns` schema rejects: the
// returns-validation-failure path. The cast is deliberate: this step's
// whole point is to violate its own declared contract at runtime, which
// only `returns.safeParse` (not TypeScript) can catch.
export default defineStep({
  description: "Always returns a value that fails its own returns schema",
  args: z.object({}),
  returns: z.object({ count: z.number() }),
  mutates: false,
  async run() {
    return { count: "not-a-number" } as unknown as { count: number };
  },
});
