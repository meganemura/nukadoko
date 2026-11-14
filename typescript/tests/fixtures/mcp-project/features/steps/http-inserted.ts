import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import addOverHttp from "./add-over-http.js";

// Counted on the lines the world wrote for the HTTP call's trace.
export default defineStep({
  pattern: "the HTTP call inserted {n:int} note(s)",
  args: z.object({ n: z.number().describe("How many notes") }),
  timeout: 1500,
  events: { inserts: { of: addOverHttp, count: { kind: "db", table: "notes", op: "insert", committed: true } } },
  claims: [{ actual: "inserts", compare: "equal", expected: "n" }],
});
