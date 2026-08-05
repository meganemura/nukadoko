import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// P5 task spec's own fixture module — every fixture here writes one JSON
// line per lifecycle event to fixture-log.jsonl, right beside this file, so
// tests/run-fixture-teardown.test.ts (and its sibling files) can read back
// what actually happened without needing to see into a separately tsx-
// loaded module instance (this fixture project's own steps read from a
// different discovery/import path than a test file does, so module-level
// state here isn't otherwise observable from outside this one `nuka run`/
// `nuka do` invocation).

const logPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-log.jsonl");

function log(entry: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

let seededDbBuildCount = 0;

export default defineConfig({
  // Kept short: tests exercising `stuckFixture`'s own timeout below wait
  // for real wall-clock time, so a small default keeps the suite fast.
  fixtureTimeout: 2_000,
  fixtures: defineFixtures({
    // Scenario scope (default, omitted): rebuilt per scenario, torn down at
    // that scenario's own end. Teardown's own conditional cleanup (`.claude-
    // team/playwright-native-design.md` 5 節's own example) is reproduced
    // here exactly: a "failed" outcome keeps the tenant around (for
    // inspection); only "passed" destroys it.
    tenant: async ({}, use) => {
      const id = "t1";
      log({ fixture: "tenant", phase: "setup", id });
      const outcome = await use({ id });
      log({ fixture: "tenant", phase: "teardown", id, outcome });
      if (outcome === "passed") {
        log({ fixture: "tenant", phase: "cleanup", id });
      }
    },
    // `"process"` scope: built once for the whole `nuka run` invocation, the
    // first time any step names it; reused by every scenario after that.
    seededDb: [
      async ({}, use) => {
        seededDbBuildCount += 1;
        const count = seededDbBuildCount;
        log({ fixture: "seededDb", phase: "setup", count });
        const outcome = await use({ count });
        log({ fixture: "seededDb", phase: "teardown", count, outcome });
      },
      { scope: "process" },
    ],
    // Never calls use() at all — P5 task spec, scope item 7's own "use() を
    // 呼び忘れた" case: `nuka do`/`nuka run` must refuse loudly, naming this
    // fixture, rather than hanging.
    neverCallsUse: async () => {
      log({ fixture: "neverCallsUse", phase: "setup-returned-without-use" });
    },
    // Never resolves and never calls use() either — the "hangs forever"
    // half of the same requirement, this time caught by the fixture's own
    // timeout (short, via the tuple's own options) rather than by an
    // immediate return.
    stuckFixture: [
      () =>
        new Promise<void>(() => {
          // Never settles, never calls use().
        }),
      { timeout: 150 },
    ],
  }),
});
