import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import get from "./get.js";
import nothing from "./nothing.js";
import post from "./post.js";

// An absence, judged on the lines the program wrote for the step before
// it: every write that persisted counts, and a rolled-back one does not.
export default defineStep({
  pattern: "nothing was written",
  args: z.object({}),
  timeout: 1500,
  events: {
    writes: { of: [get, post, nothing], count: { kind: "db", op: ["insert", "update", "delete", "other"], committed: true } },
  },
  claims: [{ actual: "writes", compare: "equal", expected: { literal: 0 } }],
});
