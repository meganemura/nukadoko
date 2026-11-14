import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import runBuild from "./run-build.js";

export default defineStep({
  pattern: "the build changed no file under src\\/",
  description: "The build's commands added, changed, or removed no path under src/",
  args: z.object({}),
  files: { source: { of: runBuild, under: "src/" } },
  claims: [{ actual: "source", compare: "equal", expected: { literal: [] } }],
});
