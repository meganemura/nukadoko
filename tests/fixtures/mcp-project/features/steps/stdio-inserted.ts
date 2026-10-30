import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import addOverStdio from "./add-over-stdio.js";

export default defineStep({
  pattern: "the stdio call inserted {n:int} note(s)",
  args: z.object({ n: z.number().describe("How many notes") }),
  timeout: 1500,
  events: { inserts: { of: addOverStdio, count: { kind: "db", table: "notes", op: "insert", committed: true } } },
  claims: [{ actual: "inserts", compare: "equal", expected: "n" }],
});
