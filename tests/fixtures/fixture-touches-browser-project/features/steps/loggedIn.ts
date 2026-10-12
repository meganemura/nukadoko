import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Shares its name with the `loggedIn` fixture on purpose: `nuka tend --json`
// must keep the step's findings and the fixture's findings apart.
export default defineStep({
  pattern: "same name as a fixture",
  description: "A step named like a config fixture",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
