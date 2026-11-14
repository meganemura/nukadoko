import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: table-docstring-key-mismatch. features/check.feature attaches a
// data table to this step; the pattern's one named capture ("a") consumes
// "a", leaving two required keys unconsumed ("rest", "extra") — the rule
// requires exactly one.
export default defineStep({
  pattern: "a table thing {a:string}",
  description: "d",
  args: z.object({ a: z.string(), rest: z.array(z.array(z.string())), extra: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
