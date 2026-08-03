import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// Exercises `from` for real (features/checkout.feature binds this line with
// no capture for `id` at all), so `from.id`'s producer genuinely supplies a
// value — the "used from" case tests/tend.test.ts checks stays silent
// about.
export default defineStep({
  pattern: "the project is closed",
  description: "Close the project created earlier in this scenario",
  rationale: "Deliberately takes no capture so from.id is the only source for id, proving a genuinely-used from stays quiet",
  args: z.object({ id: z.string().describe("the project's id, filled by from") }),
  returns: z.object({ closed: z.boolean().describe("always true") }),
  from: { id: [createProject, "id"] },
  async run() {
    return { closed: true };
  },
});
