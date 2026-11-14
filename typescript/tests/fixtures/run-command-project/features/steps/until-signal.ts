import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

const tool = fileURLToPath(new URL("../../tools/until-signal.mjs", import.meta.url));

export default defineStep({
  pattern: "a step runs a command until a signal stops it",
  description: "Runs a command, and a helper it starts, until a signal reaches them; SIGNAL_DIR names where they write",
  args: z.object({}),
  returns: z.object({ exitCode: z.number().nullable() }),
  mutates: false,
  async run() {
    const result = await runCommand(process.execPath, [tool, process.env.SIGNAL_DIR ?? ""]);
    return { exitCode: result.exitCode };
  },
});
