import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A Step object that is never any file's own default export, so discovery
// can never register it — the same "reached through a different `await
// import()`" mistake docs/spec.md "Chaining steps" and
// src/step/validate-from.ts's own header describe. This step is bound in
// two feature files on purpose (one.feature, two.feature): the structural
// finding below must still be reported exactly once, since it is a
// property of this step's own declaration, not of either scenario that
// happens to use it.
const neverDiscovered = defineStep({
  description: "not discovered on purpose — never exported as any file's default",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  run() {
    return { id: "phantom" };
  },
});

export default defineStep({
  pattern: "an unregistered upstream step runs",
  description: "from names a Step discovery never registered, on purpose",
  args: z.object({ phantomId: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  from: { phantomId: [neverDiscovered, "id"] },
  async run() {
    return { ok: true };
  },
});
