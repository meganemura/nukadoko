import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

// Returns at once and leaves a request and a command behind on a timer, so
// both start after the step's record is written and while the next step
// runs: they belong to this step, never to the one that happens to be
// running.
export default defineStep({
  pattern: "a step leaves a request and a command for later",
  description: "Starts a request and a command 300 ms after it returns",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  run({ scratch }) {
    const cwd = scratch.dir("late");
    setTimeout(() => {
      void fetch(`${process.env.CHANNELS_BASE}/late`, { method: "POST", body: "late" })
        .then((response) => response.text())
        .catch(() => undefined);
      void runCommand(process.execPath, ["-e", "process.stdout.write('late')"], { cwd }).catch(() => undefined);
    }, 300);
    return { ok: true };
  },
});
