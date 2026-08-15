import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Shared by both inside.feature and near-miss.feature (this fixture's own
// header) — nothing about the step itself is what either test file is
// about, only where each feature that calls it sits relative to
// `featuresDir`.
export default defineStep({
  pattern: "a thing happens",
  description: "Records that a thing happened (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run() {
    return { ok: true };
  },
});
