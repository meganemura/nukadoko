import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import { at, canonical } from "./lib/json-shape.ts";
import nukaRuns from "./nuka-runs.ts";
import theProject from "./the-project.ts";

export default defineStep({
  description: "The value at a path of the run.json nuka wrote, as JSON with its keys sorted, is exactly the docstring",
  pattern: "the run.json at {path:string} is",
  args: z.object({
    path: z.string().describe("Keys and [index]es, such as table.rows[1].reason"),
    expected: z.string().describe("The value as JSON, keys sorted, two-space indent"),
    dir: theProject.returns.shape.dir,
    runDir: nukaRuns.returns.shape.runDir,
  }),
  from: { dir: [theProject, "dir"], runDir: [nukaRuns, "runDir"] },
  observe({}, { path: where, dir, runDir }) {
    return { value: canonical(at(JSON.parse(readFileSync(path.join(dir, runDir, "run.json"), "utf8")), where)) };
  },
  claims: [{ actual: "value", view: "text", compare: "equal", expected: "expected" }],
});
