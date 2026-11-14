import { execFileSync } from "node:child_process";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a step starts a process without runCommand",
  description: "Starts a program through node:child_process, which nukadoko cannot measure",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  run() {
    execFileSync(process.execPath, ["-e", "0"]);
    return { ok: true };
  },
});
