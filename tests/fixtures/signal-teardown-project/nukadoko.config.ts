import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// Both fixtures append one JSON line per lifecycle event to
// fixture-log.jsonl beside this file. A test reads that file back: the
// step module and the test do not share an import cache, so module state
// would not be visible from outside this one invocation.

const logPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-log.jsonl");

function log(entry: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

export default defineConfig({
  fixtures: defineFixtures({
    tenant: async ({}, use) => {
      log({ fixture: "tenant", phase: "setup" });
      const outcome = await use({ id: "tenant" });
      log({ fixture: "tenant", phase: "teardown", outcome });
      if (outcome === "passed") {
        log({ fixture: "tenant", phase: "cleanup" });
      }
    },
    ledger: [
      async ({}, use) => {
        log({ fixture: "ledger", phase: "setup" });
        const outcome = await use({ id: "ledger" });
        log({ fixture: "ledger", phase: "teardown", outcome });
      },
      { scope: "process" },
    ],
  }),
});
