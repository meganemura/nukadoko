import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a widget exists",
  description: "Create a widget",
  rationale: "Minimal fixture step; every feature here binds the same one so the only variable under test is whether each feature has a sign-off record",
  args: z.object({}),
  returns: z.object({ ok: z.boolean().describe("always true") }),
  async run() {
    return { ok: true };
  },
});
