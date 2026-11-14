import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import post from "./post.js";

// The table comes from the line, so one step counts the writes of any.
export default defineStep({
  pattern: "{table:string} was written {n:int} time(s)",
  args: z.object({ table: z.string(), n: z.number() }),
  timeout: 1500,
  events: {
    writes: { of: post, count: { kind: "db", table: { sentence: "table" }, op: ["insert", "update", "delete", "other"], committed: true } },
  },
  claims: [{ actual: "writes", compare: "equal", expected: "n" }],
});
