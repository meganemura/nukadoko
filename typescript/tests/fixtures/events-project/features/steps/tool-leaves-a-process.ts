import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

const tool = fileURLToPath(new URL("../../app/leave-running.mjs", import.meta.url));

export default defineStep({
  pattern: "the tool leaves a process running for {ms:int} ms",
  description: "run a command-line tool that exits while a helper it started still runs in its process group",
  args: z.object({ ms: z.number() }),
  returns: z.object({ pid: z.number() }),
  mutates: false,
  async run({}, { ms }) {
    const result = await runCommand(process.execPath, [tool, String(ms)]);
    return { pid: Number(result.stdout) };
  },
});
