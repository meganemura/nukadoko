import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

// Returns at once and leaves requests and a command behind on a timer, so
// they start after the step's record is written and while the next step
// runs: they belong to this step, never to the one that happens to be
// running. The server never answers `/hang`, so that request is still
// open when the run ends.
export default defineStep({
  pattern: "a step leaves a request and a command for later",
  description: "Starts two requests and a command 300 ms after it returns",
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
      void fetch(`${process.env.CHANNELS_BASE}/hang`).catch(() => undefined);
    }, 300);
    return { ok: true };
  },
});
