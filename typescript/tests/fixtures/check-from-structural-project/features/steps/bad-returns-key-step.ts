import { z } from "zod";
import createProject from "./create-project.js";
import { defineStep } from "../../nukadoko-shim.js";

// `from` names a key ("missingKey") that is not one of create-project.ts's
// own `returns` keys ("id"/"name") — the other structural finding
// validateStepFrom makes, distinct from an unregistered upstream
// (unregistered-from-step.ts). The type system itself already
// rejects this at the literal (src/step/define-step.ts's own `FromMap`), so
// producing it at all needs the same `as` cast that file's own header names
// as the one way a step author can still get this wrong at runtime.
export default defineStep({
  pattern: "a step with a bad returns key runs",
  description: "from names a returns key the upstream step doesn't actually have",
  args: z.object({ value: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  from: { value: [createProject, "missingKey" as any] },
  async run() {
    return { ok: true };
  },
});
