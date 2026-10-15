import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a step runs two commands",
  description: "Runs one command that exits 3, then one that prints",
  args: z.object({}),
  returns: z.object({ first: z.number().nullable(), second: z.string() }),
  mutates: false,
  async run() {
    const first = await runCommand(process.execPath, ["-e", "process.exit(3)"]);
    const second = await runCommand(process.execPath, ["-e", "process.stdout.write('hello')"]);
    return { first: first.exitCode, second: second.stdout };
  },
});
