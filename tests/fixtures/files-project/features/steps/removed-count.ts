import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import runBuild from "./run-build.js";

export default defineStep({
  pattern: "the build removed {count:int} file(s)",
  description: "The build's commands removed as many paths as the line says",
  args: z.object({ count: z.number().int().describe("How many paths") }),
  files: { removed: { of: runBuild, change: "removed" } },
  claims: [{ actual: "removed", count: true, compare: "equal", expected: "count" }],
});
