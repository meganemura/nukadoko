import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A Step object that is never any file's own default export, so discovery
// can never register it — the same "reached through a different `await
// import()`" mistake check-from-structural-project's own
// unregistered-from-step.ts fixture already uses for `from`, applied here
// to `parts` instead.
const neverDiscovered = defineStep({
  description: "not discovered on purpose — never exported as any file's default",
  args: z.object({}),
  returns: z.object({}),
  run() {
    return {};
  },
});

export default defineStep({
  pattern: "a step declares an unregistered part",
  description: "parts names a Step discovery never registered, on purpose",
  args: z.object({}),
  returns: z.object({}),
  parts: [neverDiscovered],
  async run() {
    return {};
  },
});
