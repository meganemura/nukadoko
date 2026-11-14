import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import { projectDir } from "./project-dir.js";

// Writes from the step's own process, with no runCommand: nukadoko walks
// no directory for it, so no claim can say it wrote nothing.
export default defineStep({
  pattern: "the build runs in-process",
  description: "Writes a file without starting a process",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    writeFileSync(path.join(projectDir, "in-process.txt"), "written\n");
    return {};
  },
});
