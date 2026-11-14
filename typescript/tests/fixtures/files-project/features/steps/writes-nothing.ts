import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import buildInBigTree from "./build-in-big-tree.js";
import buildInProcess from "./build-in-process.js";
import buildInTwoDirs from "./build-in-two-dirs.js";
import runBuild from "./run-build.js";

export default defineStep({
  pattern: "the build writes nothing",
  description: "The build's commands added, changed, or removed no file",
  args: z.object({}),
  files: { written: { of: [runBuild, buildInProcess, buildInTwoDirs, buildInBigTree] } },
  claims: [{ actual: "written", compare: "equal", expected: { literal: [] } }],
});
