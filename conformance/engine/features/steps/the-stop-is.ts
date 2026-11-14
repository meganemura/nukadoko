import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "The --json envelope's last refused or failed finding, field by field, is this text",
  pattern: "the stop is",
  args: z.object({
    finding: z.string().describe("One line per field, field: value, in the order severity, code, message, fix, do"),
    stop: nukaRuns.returns.shape.stop,
  }),
  from: { stop: [nukaRuns, "stop"] },
  claims: [{ actual: "stop", compare: "equal", expected: "finding" }],
});
