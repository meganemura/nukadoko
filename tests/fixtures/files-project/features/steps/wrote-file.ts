import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import runBuild from "./run-build.js";

export default defineStep({
  pattern: "the build wrote the migration file {path:string}",
  description: "The build's commands added the file the line names",
  args: z.object({ path: z.string().describe("A path relative to the project directory") }),
  files: { added: { of: runBuild, change: "added" } },
  claims: [{ actual: "added", compare: "has-item", expected: "path" }],
});
