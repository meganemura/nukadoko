import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Same "never discovered" trick as archive-project-unregistered-from.ts's
// own `neverDiscovered`, reused here for `ctx.resultOf`'s own half of m6a-
// from-core task spec's item 6 acceptance test: passing an unregistered
// `Step` to `ctx.resultOf` must throw, not return `undefined`.
const neverDiscovered = defineStep({
  description: "not discovered on purpose — never exported as any file's default",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  run() {
    return { id: "phantom" };
  },
});

export default defineStep({
  pattern: "resultOf is called on a step discovery never registered",
  description: "Calls ctx.resultOf on a Step object discovery never registered, on purpose",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  async run({ resultOf }) {
    resultOf(neverDiscovered);
    return { ok: true };
  },
});
