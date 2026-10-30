import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import producer from "./sdk-add-over-http.js";

// Counted on the lines the world wrote for the SDK client's HTTP call.
export default defineStep({
  pattern: "the SDK HTTP call inserted {n:int} note(s)",
  args: z.object({ n: z.number().describe("How many notes") }),
  timeout: 1500,
  events: { inserts: { of: producer, count: { kind: "db", table: "notes", op: "insert", committed: true } } },
  claims: [{ actual: "inserts", compare: "equal", expected: "n" }],
});
