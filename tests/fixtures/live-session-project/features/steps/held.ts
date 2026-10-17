import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Holds the session busy until the test says so: it writes `started` once
// it runs, then waits for `release` to exist. tests/live-session.test.ts
// sends its second call between the two, so the overlap is observed, not
// assumed from a sleep a loaded machine can outlast.
export default defineStep({
  description: "Write the `started` file, then wait until the `release` file exists",
  args: z.object({ started: z.string(), release: z.string() }),
  returns: z.object({ released: z.boolean() }),
  mutates: false,
  async run({}, args) {
    writeFileSync(args.started, "");
    while (!existsSync(args.release)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { released: true };
  },
});
