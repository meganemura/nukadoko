import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "The first line of stderr is exactly this",
  pattern: "the error says {text:string}",
  args: z.object({
    text: z.string().describe("The expected first line of stderr"),
    stderr: runTally.returns.shape.stderr,
  }),
  from: {
    stderr: [runTally, "stderr"],
  },
  mutates: false,
  run({}, { text, stderr }) {
    const actual = stderr.split("\n")[0] ?? "";
    assert.equal(actual, text, `text: expected ${JSON.stringify(text)}, got ${JSON.stringify(actual)}`);
  },
});
