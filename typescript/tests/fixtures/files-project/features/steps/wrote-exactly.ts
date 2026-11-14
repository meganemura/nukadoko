import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import runBuild from "./run-build.js";

export default defineStep({
  pattern: "the build wrote exactly these files:",
  description: "The build's commands added or changed the listed paths and no other",
  args: z.object({ docstring: z.string().describe("One path per line, a directory ending in /") }),
  files: { written: { of: runBuild, change: ["added", "changed"] } },
  claims: [{ actual: "written", compare: "has-same-items", expected: "docstring", expected_view: "lines" }],
});
