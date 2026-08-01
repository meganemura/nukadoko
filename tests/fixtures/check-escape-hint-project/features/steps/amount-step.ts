import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deliberately buggy: the literal "(USD)" in prose is left unescaped, so
// cucumber-expressions reads "(USD)" as an optional group ("USD" optional,
// no literal parens in the compiled regex) instead of the literal
// characters the author meant. This pattern therefore never matches pickle
// text that actually contains "(USD)" — the fineract/e-petitions near-miss
// this fixture reproduces for the escape-hint diagnostic.
export default defineStep({
  pattern: "the amount (USD) is {amount:string}",
  description: "d",
  args: z.object({ amount: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
