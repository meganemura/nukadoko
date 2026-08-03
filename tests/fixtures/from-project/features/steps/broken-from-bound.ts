import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Same trick as archive-project-unregistered-from.ts (m6a-from-core task
// spec): a Step object that is never any file's own default export, so
// discovery can never register it. Unlike that file's step, *this* one is
// actually bound to a Gherkin line below — m6b-from-check task spec's own
// acceptance case: `nuka run`'s newly-closed structural `from` check
// (src/step/validate-from.ts's `validateStepFrom`, wired into cli/run.ts)
// must refuse a run whose selected feature actually binds a step like this,
// the same way `nuka do` already refuses to run it by name.
const neverDiscoveredBound = defineStep({
  description: "not discovered on purpose — never exported as any file's default",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  run() {
    return { id: "phantom" };
  },
});

export default defineStep({
  pattern: "a step with a broken from is bound",
  description: "from names a Step discovery never registered, and this step is bound to a feature line",
  args: z.object({ phantomId: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  from: { phantomId: [neverDiscoveredBound, "id"] },
  async run() {
    return { ok: true };
  },
});
