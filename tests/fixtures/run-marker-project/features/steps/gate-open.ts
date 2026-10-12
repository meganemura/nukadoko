import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Holds one run in flight until the test creates the file named by
// NUKA_GATE_FILE, so a second `nuka run` can start and finish meanwhile.
export default defineStep({
  pattern: "the gate is open",
  description: "Waits until the gate file exists",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    const gate = process.env.NUKA_GATE_FILE!;
    while (!existsSync(gate)) await sleep(20);
    return {};
  },
});
