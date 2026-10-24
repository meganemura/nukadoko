import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// Exercises `from` for real (features/checkout.feature binds this line with
// no capture for `id` at all), so `from.id`'s producer genuinely supplies a
// value: the "used from" case tests/check-notes.test.ts checks stays silent
// about.
export default defineStep({
  pattern: "the project is closed",
  description: "Close the project created earlier in this scenario",
  args: z.object({ id: z.string().describe("the project's id, filled by from") }),
  returns: z.object({ closed: z.boolean().describe("always true") }),
  from: { id: [createProject, "id"] },
  async run() {
    return { closed: true };
  },
});
