import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "stdout is exactly the docstring, ignoring a trailing newline",
  pattern: "the output is",
  args: z.object({
    expected: z.string().describe("The expected stdout, verbatim"),
    stdout: runTally.returns.shape.stdout,
  }),
  from: {
    stdout: [runTally, "stdout"],
  },
  mutates: false,
  run({}, { expected, stdout }) {
    const actual = stdout.trimEnd();
    assert.equal(actual, expected.trimEnd(), `stdout: expected ${JSON.stringify(expected.trimEnd())}, got ${JSON.stringify(actual)}`);
  },
});
