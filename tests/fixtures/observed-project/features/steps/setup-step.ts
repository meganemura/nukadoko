import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Given-position step, no network at all — establishes the scenario before
// the Then-position step under test runs.
export default defineStep({
  pattern: "a setup step exists",
  description: "A trivial Given-position step with no network calls",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
