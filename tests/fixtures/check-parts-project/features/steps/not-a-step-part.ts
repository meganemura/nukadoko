import { z } from "zod";
import { defineStep, type Step } from "../../nukadoko-shim.js";

// `parts` is typed `readonly Step[]`, so producing a non-Step entry needs
// the same `as` cast bad-returns-key-step.ts (check-from-structural-project
// fixture) uses to defeat `from`'s own type-level check — the one way a
// step author can still get this wrong at runtime.
const notAStep = { hello: "world" };

export default defineStep({
  pattern: "a step declares a non-step part",
  description: "parts names something that is not a Step, on purpose",
  args: z.object({}),
  returns: z.object({}),
  parts: [notAStep as unknown as Step],
  async run() {
    return {};
  },
});
