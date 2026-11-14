import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A required args key with no capture, table/docstring, or declared
// `from` — its own `unfillable-required-key` finding belongs to this
// step's own line (features/probe.feature's `Given` line), not the
// Scenario line above it.
export default defineStep({
  pattern: "a known step runs",
  description: "A step that exists, with a required key nothing on its line fills",
  args: z.object({ title: z.string() }),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({}, args) {
    return { ok: true };
  },
});
