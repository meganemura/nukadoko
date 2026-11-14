import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers (together with duplicate-b.ts): duplicate-pattern, a static
// vocabulary-wide check ("duplicate text {string}" normalizes identically
// for both steps) — and, because features/check.feature actually uses this
// exact text, also ambiguous-step (the pickle-level check: two steps match
// the same pickle step).
export default defineStep({
  pattern: "duplicate text {a:string}",
  description: "d",
  args: z.object({ a: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
