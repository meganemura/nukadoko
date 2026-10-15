import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Runs one command as a part",
  args: z.object({}),
  returns: z.object({ exitCode: z.number().nullable() }),
  mutates: false,
  async run() {
    const { exitCode } = await runCommand(process.execPath, ["-e", "process.exit(0)"]);
    return { exitCode };
  },
});
