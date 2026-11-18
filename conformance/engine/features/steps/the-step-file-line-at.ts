import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import { at, canonical } from "./lib/json-shape.ts";
import nukaRuns from "./nuka-runs.ts";
import theProject from "./the-project.ts";

export default defineStep({
  description:
    "The value at a path of one line of a file beside a step record, the step named by its place in run.json, as JSON with its keys sorted, is exactly the docstring",
  pattern: "line {line:int} of the {file:string} of step {step:string} at {path:string} is",
  args: z.object({
    line: z.number().describe("The line, from 1"),
    file: z.string().describe("The file beside the step record, such as mcp.jsonl"),
    step: z.string().describe("The step in run.json, such as scenarios[0].steps[1]"),
    path: z.string().describe("Keys and [index]es within the line, such as result.text"),
    expected: z.string().describe("The value as JSON, keys sorted, two-space indent"),
    dir: theProject.returns.shape.dir,
    runDir: nukaRuns.returns.shape.runDir,
  }),
  from: { dir: [theProject, "dir"], runDir: [nukaRuns, "runDir"] },
  observe({}, { line, file, step, path: where, dir, runDir }) {
    const run = JSON.parse(readFileSync(path.join(dir, runDir, "run.json"), "utf8"));
    const record = at(run, `${step}.record`) as string;
    const text = readFileSync(path.join(dir, runDir, record, file), "utf8").split("\n")[line - 1] ?? "null";
    return { value: canonical(at(JSON.parse(text), where)) };
  },
  claims: [{ actual: "value", view: "text", compare: "equal", expected: "expected" }],
});
