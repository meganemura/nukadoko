import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Test-only: exists so tests/run-concurrency.test.ts can force a worker
// process to die mid-list, uncaught by any of run-worker-entry.ts's own
// try/catch (`process.exit` ends the process immediately, right here,
// never returning to any caller) — the one way to exercise `nuka run
// --concurrency`'s own "a worker died with no record for one of its files"
// refusal without depending on a real crash the rest of this suite cannot
// reproduce on demand.
export default defineStep({
  pattern: "the worker process crashes",
  description: "Test-only: kills the current process immediately (exit code 7)",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    process.exit(7);
  },
});
