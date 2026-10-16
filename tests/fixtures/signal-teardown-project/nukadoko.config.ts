import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// Both fixtures append one JSON line per lifecycle event to
// fixture-log.jsonl beside this file. A test reads that file back: the
// step module and the test do not share an import cache, so module state
// would not be visible from outside this one invocation. tenant's setup
// also appends its process id to fixture-pids.txt, so a test can check
// that every worker process is gone. SIGNAL_TEARDOWN_HOLD_MS holds
// tenant's teardown open, for a test that needs a teardown still running
// when the second signal arrives. LEDGER_TEARDOWN_HOLD_MS holds ledger's
// teardown open, for a test that signals after every scenario has a record.

const here = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(here, "fixture-log.jsonl");
const pidsPath = path.join(here, "fixture-pids.txt");
const teardownHoldMs = Number(process.env.SIGNAL_TEARDOWN_HOLD_MS ?? "0");
const ledgerTeardownHoldMs = Number(process.env.LEDGER_TEARDOWN_HOLD_MS ?? "0");

function log(entry: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

export default defineConfig({
  fixtures: defineFixtures({
    tenant: async ({}, use) => {
      log({ fixture: "tenant", phase: "setup" });
      appendFileSync(pidsPath, `${process.pid}\n`);
      const outcome = await use({ id: "tenant" });
      log({ fixture: "tenant", phase: "teardown", outcome });
      if (teardownHoldMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, teardownHoldMs));
      }
      if (outcome === "passed") {
        log({ fixture: "tenant", phase: "cleanup" });
      }
    },
    ledger: [
      async ({}, use) => {
        log({ fixture: "ledger", phase: "setup" });
        const outcome = await use({ id: "ledger" });
        log({ fixture: "ledger", phase: "teardown", outcome });
        if (ledgerTeardownHoldMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, ledgerTeardownHoldMs));
        }
      },
      { scope: "process" },
    ],
  }),
});
