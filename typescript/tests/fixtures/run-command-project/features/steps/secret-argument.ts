import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

const PRINT_ARGUMENT = "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1])";

export default defineStep({
  pattern: "a step passes a secret to a command",
  description: "Passes a loaded secret as a command-line argument, which the command prints to both streams",
  args: z.object({}),
  returns: z.object({ exitCode: z.number().nullable() }),
  mutates: false,
  async run({ requireEnv }) {
    const token = requireEnv("CLI_TOKEN");
    const { exitCode } = await runCommand(process.execPath, ["-e", PRINT_ARGUMENT, token]);
    return { exitCode };
  },
});
