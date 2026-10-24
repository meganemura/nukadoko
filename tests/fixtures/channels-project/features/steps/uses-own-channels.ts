import http from "node:http";
import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

// Every channel here is the step's own and measured, or not a connection
// at all: console output, the process's stdio, the request fixture, fetch,
// node:http, and a command with stdin. None of it is an unmeasured socket.
export default defineStep({
  pattern: "a step uses only channels nukadoko measures",
  description: "Writes to the console, sends three requests, and runs a command with stdin",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ request }) {
    const base = process.env.CHANNELS_BASE!;
    console.log("to the console");
    console.error("to the console's error stream");
    process.stdout.write("to stdout\n");
    process.stderr.write("to stderr\n");
    await request.get(`${base}/through-request`);
    await (await fetch(`${base}/through-fetch`)).text();
    await new Promise((resolve, reject) => {
      http.get(`${base}/through-node-http`, (res) => res.resume().on("end", resolve)).on("error", reject);
    });
    await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "piped" });
    return { ok: true };
  },
});
