import path from "node:path";
import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";
import { projectDir } from "./project-dir.js";

// Runs in big/, which the test fills with more entries than nukadoko
// walks, so the record says the files were not measured.
export default defineStep({
  pattern: "the build runs in the big tree",
  description: "Runs a command in a directory too large to walk",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    await runCommand(process.execPath, ["-e", ""], { cwd: path.join(projectDir, "big") });
    return {};
  },
});
