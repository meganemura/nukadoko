import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import takesANumber from "./takes-a-number.js";

// Declares takes-a-number as a part, then calls it with a value that fails
// its own `args` schema at runtime — built through `JSON.parse` (not a
// literal) so this stays a genuine runtime mistake `call`'s own validation
// has to catch, not something the type checker would already refuse to
// compile.
export default defineStep({
  description: "Calls takes-a-number with args that fail its own schema",
  args: z.object({}),
  returns: z.object({}),
  parts: [takesANumber],
  async run({ call }) {
    const bad = JSON.parse('{"n":"not a number"}');
    await call(takesANumber, bad);
    return {};
  },
});
