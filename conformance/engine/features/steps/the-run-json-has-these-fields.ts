import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import { shapeText } from "./lib/json-shape.ts";
import nukaRuns from "./nuka-runs.ts";
import theProject from "./the-project.ts";

export default defineStep({
  description: "The run.json nuka wrote holds exactly these fields: one line per leaf path, items of an array as [], with the JSON type found there",
  pattern: "the run.json has these fields",
  args: z.object({
    expected: z.string().describe("One `path type` line per field, sorted"),
    dir: theProject.returns.shape.dir,
    runDir: nukaRuns.returns.shape.runDir,
  }),
  from: { dir: [theProject, "dir"], runDir: [nukaRuns, "runDir"] },
  observe({}, { dir, runDir }) {
    return { fields: shapeText(JSON.parse(readFileSync(path.join(dir, runDir, "run.json"), "utf8"))) };
  },
  claims: [{ actual: "fields", view: "text", compare: "equal", expected: "expected" }],
});
