import { defineStep, runCommand, z } from "nukadoko";
import { resolve } from "node:path";

export default defineStep({
  pattern: "I ask for the greeting",
  description: "Runs the greeting program",
  args: z.object({}),
  returns: z.object({ stdout: z.string(), exitCode: z.number().nullable(), stderr: z.string() }),
  mutates: false,
  async run() {
    return await runCommand(process.execPath, [resolve("lib/greet.mjs")]);
  },
});
