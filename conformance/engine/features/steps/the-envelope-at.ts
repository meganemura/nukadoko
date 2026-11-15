import { defineStep, z } from "nukadoko";
import { at, canonical } from "./lib/json-shape.ts";
import { sameStepFiles } from "./lib/engine.ts";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "The value at a path of the --json envelope nuka printed, as JSON with its keys sorted and each run or step id written as run-<id> or step-<id> and each step file as features/steps/<name>.*, is exactly the docstring",
  pattern: "the envelope at {path:string} is",
  args: z.object({
    path: z.string().describe("Keys and [index]es, such as records[0]"),
    expected: z.string().describe("The value as JSON, keys sorted, two-space indent"),
    stdout: nukaRuns.returns.shape.stdout,
  }),
  from: { stdout: [nukaRuns, "stdout"] },
  observe({}, { path: where, stdout }) {
    const value = canonical(at(JSON.parse(stdout), where));
    return { value: sameStepFiles(value.replace(/\b(run|step)-\d{8}-\d{6}-[a-z0-9]{4}\b/g, "$1-<id>")) };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected" }],
});
