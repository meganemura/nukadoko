import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A destructured fixture with a default value (`baseURL = "unused"`, a
// string default assignable to `string | undefined` so this file still
// type-checks) — a default value breaks
// nukadoko's own `fn.toString()`-based extraction, so it is refused with a
// dedicated message rather than silently mis-parsed. Never actually runs.
export default defineStep({
  pattern: "a default value step runs",
  description: "Destructures a fixture with a default value — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ baseURL = "unused" }) {
    void baseURL;
    return {};
  },
});
