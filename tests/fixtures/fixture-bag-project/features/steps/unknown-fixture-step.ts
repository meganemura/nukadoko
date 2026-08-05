import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Destructures a name that isn't one of StepFixtures' own members. `: any`
// on the first parameter is deliberate: without it, this line simply
// wouldn't compile (`Property 'bogus' does not exist on type
// 'StepFixtures'`) — TypeScript already refuses this shape for any step
// author who lets it infer the parameter's type. `any` is this fixture's
// way of reaching the *runtime* backstop (src/step/validate-fixtures.ts)
// on purpose, the same way tests/validate-from.test.ts reaches its own
// runtime check via `as unknown as Step` — proving the check still catches
// what the type layer would have, for a step that somehow bypassed it (a
// stale `as any`, a step written in plain JS, ...).
export default defineStep({
  pattern: "an unknown fixture step runs",
  description: "Destructures a fixture name nukadoko doesn't have — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ page, bogus }: any) {
    void page;
    void bogus;
    return {};
  },
});
