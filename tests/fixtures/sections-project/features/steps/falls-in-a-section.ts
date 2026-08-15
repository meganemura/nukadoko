import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Reaches two sections, then throws before ever reaching a third — proves a
// failed step's step record still carries the sections it reached before
// failing (the requirement's own reason for existing: a failed step's step
// record still lists the stages it passed through).
export default defineStep({
  pattern: "a step falls in the middle of a section",
  description: "Calls ctx.section twice, then throws",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ section }) {
    section("setup");
    section("working");
    throw new Error("boom mid-section");
  },
});
