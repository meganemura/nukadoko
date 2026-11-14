import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a step posts to the echo server and keeps what it got",
  description: "Posts the loaded token to the echo server, writes the reply into a scratch directory, and copies it with a command",
  args: z.object({}),
  returns: z.object({ status: z.number() }),
  mutates: true,
  async run({ requireEnv, scratch }) {
    const response = await fetch(`${process.env.CHANNELS_BASE}/echo`, {
      method: "POST",
      body: JSON.stringify({ token: requireEnv("CHANNEL_TOKEN") }),
    });
    const reply = await response.text();
    const dir = scratch.dir("kept");
    await writeFile(path.join(dir, "reply.json"), reply);
    await runCommand(process.execPath, ["-e", "require('node:fs').copyFileSync('reply.json', 'copy.json')"], { cwd: dir, input: "unused" });
    return { status: response.status };
  },
});
