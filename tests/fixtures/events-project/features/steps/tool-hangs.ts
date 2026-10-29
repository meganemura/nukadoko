import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

const tool = fileURLToPath(new URL("../../app/hang.mjs", import.meta.url));

export default defineStep({
  pattern: "the tool hangs past a timeout of {ms:int} ms",
  description: "run a command-line tool that never ends, whose helper holds its output open, under runCommand's timeout",
  args: z.object({ ms: z.number() }),
  returns: z.object({ stopped: z.string() }),
  mutates: false,
  async run({}, { ms }) {
    try {
      await runCommand(process.execPath, [tool], { timeout: ms });
      return { stopped: "no" };
    } catch (error) {
      return { stopped: (error as Error).message };
    }
  },
});
