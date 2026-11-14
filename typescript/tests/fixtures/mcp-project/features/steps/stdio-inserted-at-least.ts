import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import addOverStdio from "./add-over-stdio.js";

// A stdio call has no line that closes it, so only a lower bound holds.
export default defineStep({
  pattern: "the stdio call inserted at least {n:int} note(s)",
  args: z.object({ n: z.number().describe("How many notes") }),
  timeout: 1500,
  events: { inserts: { of: addOverStdio, count: { kind: "db", table: "notes", op: "insert", committed: true } } },
  claims: [{ actual: "inserts", compare: "at-least", expected: "n" }],
});
