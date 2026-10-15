import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a step passes a secret to a command",
  description: "Passes a loaded secret as a command-line argument",
  args: z.object({}),
  returns: z.object({ exitCode: z.number().nullable() }),
  mutates: false,
  async run({ requireEnv }) {
    const token = requireEnv("CLI_TOKEN");
    const { exitCode } = await runCommand(process.execPath, ["-e", "", token]);
    return { exitCode };
  },
});
