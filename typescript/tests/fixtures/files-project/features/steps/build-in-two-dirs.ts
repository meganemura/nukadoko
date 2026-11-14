import path from "node:path";
import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";
import { projectDir } from "./project-dir.js";

// Two commands in two working directories: each lists its paths relative
// to its own, so the two lists make no one list.
export default defineStep({
  pattern: "the build runs in two directories",
  description: "Runs one command in the project directory and one in src",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    await runCommand(process.execPath, ["-e", ""], { cwd: projectDir });
    await runCommand(process.execPath, ["-e", ""], { cwd: path.join(projectDir, "src") });
    return {};
  },
});
