import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `evidence.path(name)` called twice with the same name must return two
// distinct paths — returned so the test can
// compare them without reaching into the fixture project's own filesystem.
export default defineStep({
  pattern: "a step allocates a path twice with the same name",
  description: "Calls evidence.path twice with the same name, returns both paths",
  args: z.object({}),
  returns: z.object({ first: z.string(), second: z.string() }),
  mutates: false,
  async run({ evidence }) {
    const first = evidence.path("dump.csv");
    const second = evidence.path("dump.csv");
    return { first, second };
  },
});
