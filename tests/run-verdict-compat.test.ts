import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: what a compat Then comes to in the verdict table,
// against tests/fixtures/run-verdict-hooks-project. Only a claim proves: a
// compat step in Then position judges no claim, so its failed assertion is
// `broke`, and a control on it leaves the row `held`, never `proven`.

// The glue fails on its first call, which is flag-off's control (the run
// starts flag-off first), and passes after it.
const GLUE = `import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { Then } from "../../nukadoko-compat-shim.js";

Then("the compat banner reads {string}", function (state: string) {
  const base = new URL("../../.calls/", import.meta.url);
  mkdirSync(base, { recursive: true });
  let n = 1;
  for (;;) {
    try {
      mkdirSync(new URL(String(n), base));
      break;
    } catch {
      n += 1;
    }
  }
  assert.equal(n === 1 ? "off" : "on", state);
});
`;

describe("nuka run: a compat Then", () => {
  it("is broke where its assertion fails, so a control on it never proves the row", async () => {
    const rootDir = await copyFixtureToTempDir("run-verdict-hooks-project");
    try {
      writeFileSync(path.join(rootDir, "features", "steps", "compat-glue.ts"), GLUE);
      writeFileSync(path.join(rootDir, "features", "compat.feature"), 'Feature: Compat\n\n  @with:banner\n  Scenario: compat banner on\n    Then the compat banner reads "on"\n');
      const exitCode = await runCli(["run", "features/compat.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
      expect(exitCode).toBe(0);
      const row = (latestRunJson(rootDir) as { table: { rows: { verdict: string; cells: { environment: string; role: string; outcome: string; line?: number; runs: number }[] }[] } }).table.rows[0]!;
      expect(row.cells.map((cell) => [cell.environment, cell.role, cell.outcome, cell.line, cell.runs])).toEqual([
        ["flag-off", "control", "broke", 5, 1],
        ["flag-on", "required", "pass", undefined, 1],
      ]);
      expect(row.verdict).toBe("held");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
