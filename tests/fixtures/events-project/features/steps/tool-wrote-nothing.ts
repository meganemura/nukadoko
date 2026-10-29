import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import tool from "./tool.js";
import leaves from "./tool-leaves.js";
import leavesAProcess from "./tool-leaves-a-process.js";

// An absence, judged on the lines of a step that ran a command-line tool.
export default defineStep({
  pattern: "the tool wrote nothing",
  args: z.object({}),
  timeout: 1500,
  events: {
    writes: { of: [tool, leaves, leavesAProcess], count: { kind: "db", op: ["insert", "update", "delete", "other"], committed: true } },
  },
  claims: [{ actual: "writes", compare: "equal", expected: { literal: 0 } }],
});
