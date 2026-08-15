import { z } from "zod";
import { defineStep } from "nukadoko";

// The only step acceptance.feature calls. Pure, no browser, no HTTP --
// selftest-suite/features/steps/acceptance-lifecycle.ts's own scenarios
// only need a real `nuka run` + `nuka accept` cycle to exercise, never an
// app to drive.
export default defineStep({
  pattern: "a thing happens",
  description: "Records that a thing happened (selftest fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run() {
    return { ok: true };
  },
});
